/**
 * Shared batch broadcast for delivering activities to all followers.
 * Deduplicates by shared inbox and delivers in batches with delay.
 * @module batch-broadcast
 */
import { logActivity } from "./activity-log.js";
import { getSettings } from "./settings.js";

/**
 * Broadcast an activity to all followers via batch delivery.
 *
 * @param {object} options
 * @param {object} options.federation - Fedify Federation instance
 * @param {object} options.collections - MongoDB collections (needs ap_followers, ap_activities)
 * @param {string} options.publicationUrl - Our publication URL
 * @param {string} options.handle - Our actor handle
 * @param {object} options.activity - Fedify activity object to send
 * @param {string} options.label - Human-readable label for logging (e.g. "Update(Person)")
 * @param {string} [options.objectUrl] - URL of the object being broadcast about
 */
export async function batchBroadcast({
  federation,
  collections,
  publicationUrl,
  handle,
  activity,
  label,
  objectUrl,
}) {
  const settings = await getSettings(collections);
  const batchSize = settings.broadcastBatchSize;
  const batchDelay = settings.broadcastBatchDelay;

  const ctx = federation.createContext(new URL(publicationUrl), {
    handle,
    publicationUrl,
  });

  const followers = await collections.ap_followers
    .find({})
    .project({ actorUrl: 1, inbox: 1, sharedInbox: 1 })
    .toArray();

  // Deduplicate by shared inbox
  const inboxMap = new Map();
  for (const f of followers) {
    const key = f.sharedInbox || f.inbox;
    if (key && !inboxMap.has(key)) {
      inboxMap.set(key, f);
    }
  }

  const uniqueRecipients = [...inboxMap.values()];
  let delivered = 0;
  let failed = 0;

  console.info(
    `[ActivityPub] Broadcasting ${label} to ${uniqueRecipients.length} ` +
      `unique inboxes (${followers.length} followers) in batches of ${batchSize}`,
  );

  for (let i = 0; i < uniqueRecipients.length; i += batchSize) {
    const batch = uniqueRecipients.slice(i, i + batchSize);
    const recipients = batch.map((f) => ({
      id: new URL(f.actorUrl),
      inboxId: new URL(f.inbox || f.sharedInbox),
      endpoints: f.sharedInbox
        ? { sharedInbox: new URL(f.sharedInbox) }
        : undefined,
    }));

    try {
      await ctx.sendActivity({ identifier: handle }, recipients, activity, {
        preferSharedInbox: true,
      });
      delivered += batch.length;
    } catch (error) {
      failed += batch.length;
      console.warn(
        `[ActivityPub] ${label} batch ${Math.floor(i / batchSize) + 1} failed: ${error.message}`,
      );
    }

    if (i + batchSize < uniqueRecipients.length) {
      await new Promise((resolve) => setTimeout(resolve, batchDelay));
    }
  }

  console.info(
    `[ActivityPub] ${label} broadcast complete: ${delivered} delivered, ${failed} failed`,
  );

  await logActivity(collections.ap_activities, {
    direction: "outbound",
    type: label.includes("(") ? label.split("(")[0] : label,
    actorUrl: publicationUrl,
    objectUrl: objectUrl || "",
    summary: `Sent ${label} to ${delivered}/${uniqueRecipients.length} inboxes`,
  }).catch(() => {});
}
