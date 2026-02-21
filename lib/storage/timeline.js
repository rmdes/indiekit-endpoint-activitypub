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
 * @param {string[]} item.category - Tags/categories
 * @param {string[]} item.photo - Photo URLs
 * @param {string[]} item.video - Video URLs
 * @param {string[]} item.audio - Audio URLs
 * @param {string} [item.inReplyTo] - Parent post URL
 * @param {object} [item.boostedBy] - { name, url, photo, handle } for boosts
 * @param {Date} [item.boostedAt] - Boost timestamp
 * @param {string} [item.originalUrl] - Original post URL for boosts
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
 * Get timeline items with cursor-based pagination
 * @param {object} collections - MongoDB collections
 * @param {object} options - Query options
 * @param {string} [options.before] - Before cursor (published date)
 * @param {string} [options.after] - After cursor (published date)
 * @param {number} [options.limit=20] - Items per page
 * @param {string} [options.type] - Filter by type
 * @param {string} [options.authorUrl] - Filter by author URL
 * @returns {Promise<object>} { items, before, after }
 */
export async function getTimelineItems(collections, options = {}) {
  const { ap_timeline } = collections;
  const parsedLimit = Number.parseInt(options.limit, 10);
  const limit = Math.min(
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20,
    100,
  );

  const query = {};

  // Type filter
  if (options.type) {
    query.type = options.type;
  }

  // Author filter (for profile view) — validate string type to prevent operator injection
  if (options.authorUrl) {
    if (typeof options.authorUrl !== "string") {
      throw new Error("Invalid authorUrl");
    }

    query["author.url"] = options.authorUrl;
  }

  // Cursor pagination — validate dates
  if (options.before) {
    const beforeDate = new Date(options.before);

    if (Number.isNaN(beforeDate.getTime())) {
      throw new Error("Invalid before cursor");
    }

    query.published = { $lt: beforeDate };
  } else if (options.after) {
    const afterDate = new Date(options.after);

    if (Number.isNaN(afterDate.getTime())) {
      throw new Error("Invalid after cursor");
    }

    query.published = { $gt: afterDate };
  }

  const rawItems = await ap_timeline
    .find(query)
    .sort({ published: -1 })
    .limit(limit)
    .toArray();

  // Normalize published dates to ISO strings for Nunjucks | date filter
  const items = rawItems.map((item) => ({
    ...item,
    published: item.published instanceof Date
      ? item.published.toISOString()
      : item.published,
  }));

  // Generate cursors for pagination
  const before =
    items.length > 0
      ? items[0].published
      : null;
  const after =
    items.length > 0
      ? items[items.length - 1].published
      : null;

  return {
    items,
    before,
    after,
  };
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
  const result = await ap_timeline.deleteMany({ published: { $lt: cutoffDate } });
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
