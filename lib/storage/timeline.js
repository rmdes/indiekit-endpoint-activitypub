/**
 * Timeline item storage operations
 * @module storage/timeline
 */

/**
 * Add a timeline item (uses atomic upsert for deduplication)
 * @param {object} collections - MongoDB collections
 * @param {object} item - Timeline item data
 * @param {string} item.uid - Canonical AP object URL (dedup key)
 * @param {string} item.type - "note" | "article" | "boost"
 * @param {string} item.url - Post URL
 * @param {string} [item.name] - Post title (articles only)
 * @param {object} item.content - { text, html }
 * @param {string} [item.summary] - Content warning text
 * @param {boolean} item.sensitive - Sensitive content flag
 * @param {Date} item.published - Published date (kept as Date for sort queries)
 * @param {object} item.author - { name, url, photo, handle }
 * @param {string[]} item.category - Hashtag strings (# prefix stripped)
 * @param {Array<{name: string, url: string}>} [item.mentions] - @mention entries with actor URLs
 * @param {string[]} item.photo - Photo URLs
 * @param {string[]} item.video - Video URLs
 * @param {string[]} item.audio - Audio URLs
 * @param {string} [item.inReplyTo] - Parent post URL
 * @param {object} [item.boostedBy] - { name, url, photo, handle } for boosts
 * @param {string} [item.boostedAt] - Boost timestamp (ISO string)
 * @param {string} [item.originalUrl] - Original post URL for boosts
 * @param {Array<{url: string, title: string, description: string, image: string, favicon: string, domain: string, fetchedAt: string}>} [item.linkPreviews] - OpenGraph link previews for external links in content
 * @param {string} item.createdAt - ISO string creation timestamp
 * @returns {Promise<object>} Created or existing item
 */
export async function addTimelineItem(collections, item) {
  const { ap_timeline } = collections;

  const result = await ap_timeline.updateOne(
    { uid: item.uid },
    {
      $setOnInsert: {
        ...item,
        readBy: [],
        // Stage 2 fields, set at ingest so newly-arriving items sort and filter
        // correctly without waiting for a backfill.
        //   receivedAt — arrival time; the timeline's sort key (DD-1)
        //   readAt     — shared read state, null until read (DD-3)
        // `item.receivedAt` wins when the caller supplies one: reply-chain
        // ancestors inherit their descendant's arrival time so backfilled
        // thread context does not surface at the top of the feed.
        receivedAt: item.receivedAt || new Date().toISOString(),
        readAt: item.readAt ?? null,
        read: false,
      },
    },
    { upsert: true },
  );

  if (result.upsertedCount > 0) {
    return await ap_timeline.findOne({ uid: item.uid });
  }

  // Return existing document if it was a duplicate
  return await ap_timeline.findOne({ uid: item.uid });
}


/**
 * Get a single timeline item by UID
 * @param {object} collections - MongoDB collections
 * @param {string} uid - Item UID (canonical URL)
 * @returns {Promise<object|null>} Timeline item or null
 */
export async function getTimelineItem(collections, uid) {
  const { ap_timeline } = collections;
  return await ap_timeline.findOne({ uid });
}

/**
 * Delete a timeline item by UID
 * @param {object} collections - MongoDB collections
 * @param {string} uid - Item UID
 * @returns {Promise<object>} Delete result
 */
export async function deleteTimelineItem(collections, uid) {
  const { ap_timeline } = collections;
  return await ap_timeline.deleteOne({ uid });
}

/**
 * Update a timeline item's content (for Update activities)
 * @param {object} collections - MongoDB collections
 * @param {string} uid - Item UID
 * @param {object} updates - Fields to update
 * @param {object} [updates.content] - New content
 * @param {string} [updates.name] - New title
 * @param {string} [updates.summary] - New content warning
 * @param {boolean} [updates.sensitive] - New sensitive flag
 * @returns {Promise<object>} Update result
 */
export async function updateTimelineItem(collections, uid, updates) {
  const { ap_timeline } = collections;
  return await ap_timeline.updateOne({ uid }, { $set: updates });
}

/**
 * Delete timeline items older than a cutoff date (retention cleanup)
 * @param {object} collections - MongoDB collections
 * @param {Date} cutoffDate - Delete items published before this date
 * @returns {Promise<number>} Number of items deleted
 */
export async function deleteOldTimelineItems(collections, cutoffDate) {
  const { ap_timeline } = collections;
  // published is stored as ISO string — convert cutoff to string for comparison
  const cutoff = cutoffDate instanceof Date ? cutoffDate.toISOString() : cutoffDate;
  const result = await ap_timeline.deleteMany({ published: { $lt: cutoff } });
  return result.deletedCount;
}

/**
 * Delete timeline items by count-based retention (keep N newest)
 * @param {object} collections - MongoDB collections
 * @param {number} keepCount - Number of items to keep
 * @returns {Promise<number>} Number of items deleted
 */
export async function cleanupTimelineByCount(collections, keepCount) {
  const { ap_timeline } = collections;

  // Find the Nth newest item's published date
  const items = await ap_timeline
    .find({})
    .sort({ published: -1 })
    .skip(keepCount)
    .limit(1)
    .toArray();

  if (items.length === 0) {
    return 0; // Fewer than keepCount items exist
  }

  const cutoffDate = items[0].published;
  return await deleteOldTimelineItems(collections, cutoffDate);
}



