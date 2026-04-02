/**
 * Timeline retention cleanup — removes old timeline items to prevent
 * unbounded collection growth and cleans up stale interaction tracking.
 */

/**
 * Remove timeline items beyond the retention limit and clean up
 * corresponding ap_interactions entries.
 *
 * Uses aggregation to identify exact items to delete by UID,
 * avoiding race conditions between finding and deleting.
 *
 * @param {object} collections - MongoDB collections
 * @param {number} retentionLimit - Max number of timeline items to keep
 * @returns {Promise<{removed: number, interactionsRemoved: number}>}
 */
export async function cleanupTimeline(collections, retentionLimit) {
  if (!collections.ap_timeline || retentionLimit <= 0) {
    return { removed: 0, interactionsRemoved: 0 };
  }

  // Get the local profile URL to exempt own posts from cleanup.
  // Own posts are your content — they should never be deleted by retention.
  const profile = collections.ap_profile
    ? await collections.ap_profile.findOne({})
    : null;
  const ownerUrl = profile?.url || null;

  // Only count remote posts toward retention limit
  const remoteFilter = ownerUrl
    ? { "author.url": { $ne: ownerUrl } }
    : {};
  const remoteCount = await collections.ap_timeline.countDocuments(remoteFilter);
  if (remoteCount <= retentionLimit) {
    return { removed: 0, interactionsRemoved: 0 };
  }

  // Find remote items beyond the retention limit, sorted newest-first.
  // Own posts are excluded from the aggregation pipeline entirely.
  const pipeline = [
    ...(ownerUrl ? [{ $match: { "author.url": { $ne: ownerUrl } } }] : []),
    { $sort: { published: -1 } },
    { $skip: retentionLimit },
    { $project: { uid: 1 } },
  ];
  const toDelete = await collections.ap_timeline
    .aggregate(pipeline)
    .toArray();

  if (!toDelete.length) {
    return { removed: 0, interactionsRemoved: 0 };
  }

  const removedUids = toDelete.map((item) => item.uid).filter(Boolean);

  // Delete old timeline items by UID
  const deleteResult = await collections.ap_timeline.deleteMany({
    _id: { $in: toDelete.map((item) => item._id) },
  });

  // Clean up stale interactions for removed items
  let interactionsRemoved = 0;
  if (removedUids.length > 0 && collections.ap_interactions) {
    const interactionResult = await collections.ap_interactions.deleteMany({
      objectUrl: { $in: removedUids },
    });
    interactionsRemoved = interactionResult.deletedCount || 0;
  }

  const removed = deleteResult.deletedCount || 0;

  if (removed > 0) {
    console.info(
      `[ActivityPub] Timeline cleanup: removed ${removed} items, ${interactionsRemoved} stale interactions`,
    );
  }

  return { removed, interactionsRemoved };
}

/**
 * Schedule periodic timeline cleanup.
 *
 * @param {object} collections - MongoDB collections
 * @param {number} retentionLimit - Max number of timeline items to keep
 * @param {number} intervalMs - Cleanup interval in milliseconds (default: 24 hours)
 * @returns {NodeJS.Timeout} The interval timer (for cleanup if needed)
 */
export function scheduleCleanup(collections, retentionLimit, intervalMs = 86_400_000) {
  // Run immediately on startup
  cleanupTimeline(collections, retentionLimit).catch((error) => {
    console.error("[ActivityPub] Timeline cleanup failed:", error.message);
  });

  // Then run periodically
  return setInterval(() => {
    cleanupTimeline(collections, retentionLimit).catch((error) => {
      console.error("[ActivityPub] Timeline cleanup failed:", error.message);
    });
  }, intervalMs);
}
