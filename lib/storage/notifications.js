/**
 * Notification storage operations
 * @module storage/notifications
 */

/**
 * Add a notification (uses atomic upsert for deduplication)
 * @param {object} collections - MongoDB collections
 * @param {object} notification - Notification data
 * @param {string} notification.uid - Activity ID or constructed dedup key
 * @param {string} notification.type - "like" | "boost" | "follow" | "mention" | "reply"
 * @param {string} notification.actorUrl - Remote actor URL
 * @param {string} notification.actorName - Display name
 * @param {string} notification.actorPhoto - Avatar URL
 * @param {string} notification.actorHandle - @user@instance
 * @param {string} [notification.targetUrl] - The post they liked/boosted/replied to
 * @param {string} [notification.targetName] - Post title
 * @param {object} [notification.content] - { text, html } for mentions/replies
 * @param {Date} notification.published - Activity timestamp (kept as Date for sort)
 * @param {string} notification.createdAt - ISO string creation timestamp
 * @returns {Promise<object>} Created or existing notification
 */
export async function addNotification(collections, notification) {
  const { ap_notifications } = collections;

  const result = await ap_notifications.updateOne(
    { uid: notification.uid },
    {
      $setOnInsert: {
        ...notification,
        read: false,
      },
    },
    { upsert: true },
  );

  if (result.upsertedCount > 0) {
    return await ap_notifications.findOne({ uid: notification.uid });
  }

  // Return existing document if it was a duplicate
  return await ap_notifications.findOne({ uid: notification.uid });
}

/**
 * Get notifications with cursor-based pagination
 * @param {object} collections - MongoDB collections
 * @param {object} options - Query options
 * @param {string} [options.before] - Before cursor (published date)
 * @param {number} [options.limit=20] - Items per page
 * @param {boolean} [options.unreadOnly=false] - Show only unread notifications
 * @param {string} [options.type] - Filter by notification type (like, boost, follow, reply, mention)
 * @returns {Promise<object>} { items, before }
 */
export async function getNotifications(collections, options = {}) {
  const { ap_notifications } = collections;
  const parsedLimit = Number.parseInt(options.limit, 10);
  const limit = Math.min(
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20,
    100,
  );

  const query = {};

  // Type filter
  if (options.type) {
    // "reply" tab shows both replies and mentions
    if (options.type === "reply") {
      query.type = { $in: ["reply", "mention"] };
    } else {
      query.type = options.type;
    }
  }

  // Unread filter
  if (options.unreadOnly) {
    query.read = false;
  }

  // Cursor pagination — published is stored as ISO string, so compare
  // as strings (lexicographic ISO 8601 comparison is correct for dates)
  if (options.before) {
    query.published = { $lt: options.before };
  }

  const rawItems = await ap_notifications
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

  // Generate cursor for next page (only if full page returned = more may exist)
  const before =
    items.length === limit
      ? items[items.length - 1].published
      : null;

  return {
    items,
    before,
  };
}

/**
 * Get notification counts grouped by type
 * @param {object} collections - MongoDB collections
 * @param {boolean} [unreadOnly=false] - Count only unread notifications
 * @returns {Promise<object>} Counts per type { all, reply, like, boost, follow }
 */
export async function getNotificationCountsByType(collections, unreadOnly = false) {
  const { ap_notifications } = collections;
  const matchStage = unreadOnly ? { $match: { read: false } } : { $match: {} };

  const pipeline = [
    matchStage,
    { $group: { _id: "$type", count: { $sum: 1 } } },
  ];

  const results = await ap_notifications.aggregate(pipeline).toArray();

  const counts = { all: 0, reply: 0, like: 0, boost: 0, follow: 0 };
  for (const { _id, count } of results) {
    counts.all += count;
    if (_id === "reply" || _id === "mention") {
      counts.reply += count;
    } else if (counts[_id] !== undefined) {
      counts[_id] = count;
    }
  }

  return counts;
}

/**
 * Get count of unread notifications
 * @param {object} collections - MongoDB collections
 * @returns {Promise<number>} Unread notification count
 */
export async function getUnreadNotificationCount(collections) {
  const { ap_notifications } = collections;
  return await ap_notifications.countDocuments({ read: false });
}

/**
 * Mark notifications as read
 * @param {object} collections - MongoDB collections
 * @param {string[]} uids - Notification UIDs to mark read
 * @returns {Promise<object>} Update result
 */
export async function markNotificationsRead(collections, uids) {
  const { ap_notifications } = collections;
  return await ap_notifications.updateMany(
    { uid: { $in: uids } },
    { $set: { read: true } },
  );
}

/**
 * Mark all notifications as read
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object>} Update result
 */
export async function markAllNotificationsRead(collections) {
  const { ap_notifications } = collections;
  return await ap_notifications.updateMany({}, { $set: { read: true } });
}

/**
 * Delete all notifications
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object>} Delete result
 */
export async function clearAllNotifications(collections) {
  const { ap_notifications } = collections;
  return await ap_notifications.deleteMany({});
}

/**
 * Delete a single notification by UID
 * @param {object} collections - MongoDB collections
 * @param {string} uid - Notification UID
 * @returns {Promise<object>} Delete result
 */
export async function deleteNotification(collections, uid) {
  const { ap_notifications } = collections;
  return await ap_notifications.deleteOne({ uid });
}
