/**
 * Batch re-follow processor for imported accounts.
 *
 * After a Mastodon migration, imported accounts (source: "import") exist only
 * locally — no Follow activities were sent. This module gradually sends Follow
 * activities to all imported accounts so remote servers start delivering
 * Create activities to our inbox.
 *
 * Source field state machine:
 *   import → refollow:sent → federation     (happy path)
 *   import → refollow:sent → refollow:failed (after MAX_RETRIES)
 */

import { Follow } from "@fedify/fedify";
import { logActivity } from "./activity-log.js";

const BATCH_SIZE = 10;
const DELAY_PER_FOLLOW = 3_000;
const DELAY_BETWEEN_BATCHES = 30_000;
const STARTUP_DELAY = 30_000;
const RETRY_COOLDOWN = 60 * 60 * 1_000; // 1 hour
const MAX_RETRIES = 3;

const KV_KEY = "batch-refollow/state";

let _timer = null;

/**
 * Start the batch re-follow processor.
 *
 * @param {object} options
 * @param {import("@fedify/fedify").Federation} options.federation
 * @param {object} options.collections - MongoDB collections
 * @param {string} options.handle - Actor handle
 * @param {string} options.publicationUrl - Publication base URL
 */
export async function startBatchRefollow(options) {
  const { collections } = options;

  // Restart recovery: reset any stale "refollow:pending" back to "import"
  await collections.ap_following.updateMany(
    { source: "refollow:pending" },
    { $set: { source: "import" } },
  );

  // Check if there's work to do
  const importCount = await collections.ap_following.countDocuments({
    source: "import",
  });

  if (importCount === 0) {
    console.info("[ActivityPub] Batch refollow: no imported accounts to process");
    return;
  }

  console.info(
    `[ActivityPub] Batch refollow: ${importCount} imported accounts to process`,
  );

  // Set job state to running
  await setJobState(collections, "running");

  // Schedule first batch after startup delay
  _timer = setTimeout(() => processNextBatch(options), STARTUP_DELAY);
}

/**
 * Pause the batch re-follow processor.
 *
 * @param {object} collections - MongoDB collections
 */
export async function pauseBatchRefollow(collections) {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }

  // Reset any pending back to import so they get picked up on resume
  await collections.ap_following.updateMany(
    { source: "refollow:pending" },
    { $set: { source: "import" } },
  );

  await setJobState(collections, "paused");
  console.info("[ActivityPub] Batch refollow: paused");
}

/**
 * Resume the batch re-follow processor.
 *
 * @param {object} options
 * @param {import("@fedify/fedify").Federation} options.federation
 * @param {object} options.collections - MongoDB collections
 * @param {string} options.handle - Actor handle
 * @param {string} options.publicationUrl - Publication base URL
 */
export async function resumeBatchRefollow(options) {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }

  await setJobState(options.collections, "running");
  _timer = setTimeout(() => processNextBatch(options), DELAY_BETWEEN_BATCHES);
  console.info("[ActivityPub] Batch refollow: resumed");
}

/**
 * Get current batch re-follow status.
 *
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object>} Status object
 */
export async function getBatchRefollowStatus(collections) {
  const state = await collections.ap_kv.findOne({ _id: KV_KEY });
  const status = state?.value?.status || "idle";

  const [remaining, sent, failed, federated] = await Promise.all([
    collections.ap_following.countDocuments({ source: "import" }),
    collections.ap_following.countDocuments({ source: "refollow:sent" }),
    collections.ap_following.countDocuments({ source: "refollow:failed" }),
    collections.ap_following.countDocuments({ source: "federation" }),
  ]);

  // Include federated in totals — accounts transition from refollow:sent
  // to federation when Accept arrives, so they must stay in the math
  const total = remaining + sent + failed + federated;
  const completed = sent + failed + federated;
  const progressPercent =
    total > 0 ? Math.round((completed / total) * 100) : 100;

  return {
    status,
    total,
    remaining,
    sent,
    failed,
    federated,
    completed,
    progressPercent,
    startedAt: state?.value?.startedAt || null,
    updatedAt: state?.value?.updatedAt || null,
  };
}

// --- Internal helpers ---

/**
 * Process the next batch of imported accounts.
 */
async function processNextBatch(options) {
  const { federation, collections, handle, publicationUrl } = options;
  _timer = null;

  const state = await collections.ap_kv.findOne({ _id: KV_KEY });
  if (state?.value?.status !== "running") return;

  // Claim a batch atomically: set source to "refollow:pending"
  const entries = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const doc = await collections.ap_following.findOneAndUpdate(
      { source: "import" },
      { $set: { source: "refollow:pending" } },
      { returnDocument: "after" },
    );
    if (!doc) break;
    entries.push(doc);
  }

  // Also pick up retryable entries (failed but not permanently)
  const retryCutoff = new Date(Date.now() - RETRY_COOLDOWN).toISOString();
  const retrySlots = BATCH_SIZE - entries.length;
  for (let i = 0; i < retrySlots; i++) {
    const doc = await collections.ap_following.findOneAndUpdate(
      {
        source: "refollow:sent",
        refollowAttempts: { $lt: MAX_RETRIES },
        refollowLastAttempt: { $lt: retryCutoff },
      },
      { $set: { source: "refollow:pending" } },
      { returnDocument: "after" },
    );
    if (!doc) break;
    entries.push(doc);
  }

  if (entries.length === 0) {
    // Check if there are still sent entries awaiting Accept
    const pendingAccepts = await collections.ap_following.countDocuments({
      source: "refollow:sent",
    });

    if (pendingAccepts > 0) {
      console.info(
        `[ActivityPub] Batch refollow: all sent, ${pendingAccepts} awaiting Accept`,
      );
    }

    await setJobState(collections, "completed");
    console.info("[ActivityPub] Batch refollow: completed");
    return;
  }

  console.info(
    `[ActivityPub] Batch refollow: processing batch of ${entries.length}`,
  );

  for (const entry of entries) {
    await processOneFollow(options, entry);
    // Delay between individual follows
    await sleep(DELAY_PER_FOLLOW);
  }

  // Update job state timestamp
  await setJobState(collections, "running");

  // Schedule next batch
  _timer = setTimeout(() => processNextBatch(options), DELAY_BETWEEN_BATCHES);
}

/**
 * Send a Follow activity for a single imported account.
 */
async function processOneFollow(options, entry) {
  const { federation, collections, handle, publicationUrl } = options;

  try {
    const ctx = federation.createContext(new URL(publicationUrl), {});

    // Resolve the remote actor
    const remoteActor = await ctx.lookupObject(entry.actorUrl);
    if (!remoteActor) {
      throw new Error("Could not resolve remote actor");
    }

    // Use the canonical actor URL (may differ from imported URL)
    const canonicalUrl = remoteActor.id?.href || entry.actorUrl;

    // Send Follow activity using canonical URL
    const follow = new Follow({
      actor: ctx.getActorUri(handle),
      object: new URL(canonicalUrl),
    });

    await ctx.sendActivity({ identifier: handle }, remoteActor, follow);

    // Mark as sent — update actorUrl to canonical form so Accept handler
    // can match when the remote server responds
    const updateFields = {
      source: "refollow:sent",
      refollowLastAttempt: new Date().toISOString(),
      refollowError: null,
    };
    if (canonicalUrl !== entry.actorUrl) {
      updateFields.actorUrl = canonicalUrl;
    }

    await collections.ap_following.updateOne(
      { _id: entry._id },
      {
        $set: updateFields,
        $inc: { refollowAttempts: 1 },
      },
    );

    console.info(
      `[ActivityPub] Batch refollow: sent Follow to ${entry.actorUrl}`,
    );

    await logActivity(collections.ap_activities, {
      direction: "outbound",
      type: "Follow",
      actorUrl: publicationUrl,
      objectUrl: entry.actorUrl,
      actorName: entry.name || entry.actorUrl,
      summary: `Batch refollow: sent Follow to ${entry.name || entry.actorUrl}`,
    });
  } catch (error) {
    const attempts = (entry.refollowAttempts || 0) + 1;
    const newSource =
      attempts >= MAX_RETRIES ? "refollow:failed" : "refollow:sent";

    await collections.ap_following.updateOne(
      { _id: entry._id },
      {
        $set: {
          source: newSource,
          refollowLastAttempt: new Date().toISOString(),
          refollowError: error.message,
        },
        $inc: { refollowAttempts: 1 },
      },
    );

    console.warn(
      `[ActivityPub] Batch refollow: failed for ${entry.actorUrl} (attempt ${attempts}/${MAX_RETRIES}): ${error.message}`,
    );
  }
}

/**
 * Set the batch re-follow job state in ap_kv.
 */
async function setJobState(collections, status) {
  const now = new Date().toISOString();
  const update = {
    $set: {
      "value.status": status,
      "value.updatedAt": now,
    },
    $setOnInsert: { _id: KV_KEY },
  };

  // Only set startedAt on initial start or resume
  const existing = await collections.ap_kv.findOne({ _id: KV_KEY });
  if (!existing?.value?.startedAt || status === "running" && existing?.value?.status !== "running") {
    update.$set["value.startedAt"] = now;
  }

  await collections.ap_kv.updateOne({ _id: KV_KEY }, update, { upsert: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
