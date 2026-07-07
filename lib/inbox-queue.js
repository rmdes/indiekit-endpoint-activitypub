/**
 * MongoDB-backed inbox processing queue.
 * Runs a setInterval-based processor that dequeues and processes
 * one activity at a time from ap_inbox_queue.
 * @module inbox-queue
 */

import { routeToHandler } from "./inbox-handlers.js";

/**
 * Process the next pending item from the inbox queue.
 * Uses findOneAndUpdate for atomic claim (prevents double-processing).
 *
 * @param {object} collections - MongoDB collections
 * @param {object} ctx - Fedify context
 * @param {string} handle - Our actor handle
 */
async function processNextItem(collections, ctx, handle) {
  const { ap_inbox_queue } = collections;
  if (!ap_inbox_queue) return false;

  const item = await ap_inbox_queue.findOneAndUpdate(
    { status: "pending" },
    { $set: { status: "processing" } },
    { sort: { receivedAt: 1 }, returnDocument: "after" },
  );
  if (!item) return false;

  try {
    await routeToHandler(item, collections, ctx, handle);
    // Delete completed items immediately — prevents unbounded collection growth
    // that caused the inbox processor to hang on restart (95K+ documents).
    await ap_inbox_queue.deleteOne({ _id: item._id });
  } catch (error) {
    const attempts = (item.attempts || 0) + 1;
    await ap_inbox_queue.updateOne(
      { _id: item._id },
      {
        $set: {
          status: attempts >= (item.maxAttempts || 3) ? "failed" : "pending",
          attempts,
          error: error.message,
        },
      },
    );
    console.error(`[inbox-queue] Failed processing ${item.activityType} from ${item.actorUrl}: ${error.message}`);
  }

  return true;
}

/**
 * Enqueue an activity for async processing.
 * @param {object} collections - MongoDB collections
 * @param {object} params
 * @param {string} params.activityType - Activity type name
 * @param {string} params.actorUrl - Actor URL
 * @param {string} [params.objectUrl] - Object URL
 * @param {object} params.rawJson - Full activity JSON-LD
 */
export async function enqueueActivity(collections, { activityType, actorUrl, objectUrl, rawJson }) {
  const { ap_inbox_queue } = collections;
  if (!ap_inbox_queue) return;

  await ap_inbox_queue.insertOne({
    activityType,
    actorUrl: actorUrl || "",
    objectUrl: objectUrl || "",
    rawJson,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    receivedAt: new Date().toISOString(),
    processedAt: null,
    error: null,
  });
}

const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 1_000;

/**
 * Start the background inbox processor.
 * @param {object} collections - MongoDB collections
 * @param {Function} getCtx - Function returning a Fedify context
 * @param {string} handle - Our actor handle
 * @returns {NodeJS.Timeout} Interval ID (for cleanup)
 */
export function startInboxProcessor(collections, getCtx, handle) {
  // Recover items stranded in "processing" by a previous crash (claimed via
  // findOneAndUpdate but never completed). The processor only queries "pending",
  // so without this reset a crash mid-processing loses the activity permanently.
  // Fire-and-forget: the first poll is POLL_INTERVAL_MS away, and any stranded
  // item is necessarily from a prior run (nothing is in-flight yet at startup).
  collections.ap_inbox_queue
    ?.updateMany({ status: "processing" }, { $set: { status: "pending" } })
    .then((result) => {
      if (result?.modifiedCount) {
        console.info(
          `[inbox-queue] Reset ${result.modifiedCount} stranded 'processing' item(s) to 'pending'`,
        );
      }
    })
    .catch((error) =>
      console.warn("[inbox-queue] Startup reset failed:", error.message),
    );

  const intervalId = setInterval(async () => {
    try {
      const ctx = getCtx();
      if (!ctx) return;
      for (let i = 0; i < BATCH_SIZE; i++) {
        const hadWork = await processNextItem(collections, ctx, handle);
        if (!hadWork) break; // Queue empty, stop early
      }
    } catch (error) {
      console.error("[inbox-queue] Processor error:", error.message);
    }
  }, POLL_INTERVAL_MS);

  console.info(`[ActivityPub] Inbox queue processor started (${POLL_INTERVAL_MS}ms interval, batch size ${BATCH_SIZE})`);
  return intervalId;
}
