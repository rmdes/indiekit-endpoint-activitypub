/**
 * Direct message storage operations
 * @module storage/messages
 */

/**
 * Add a message (uses atomic upsert for deduplication)
 * @param {object} collections - MongoDB collections
 * @param {object} message - Message data
 * @param {string} message.uid - Activity/object ID (dedup key)
 * @param {string} message.actorUrl - Other party's actor URL
 * @param {string} message.actorName - Display name
 * @param {string} message.actorPhoto - Avatar URL
 * @param {string} message.actorHandle - @user@instance
 * @param {object} message.content - { text, html } (sanitized)
 * @param {string|null} message.inReplyTo - Parent message URL for threading
 * @param {string} message.conversationId - Grouping key (other party's actorUrl)
 * @param {"inbound"|"outbound"} message.direction - Message direction
 * @param {string} message.published - ISO 8601 timestamp
 * @param {string} message.createdAt - ISO 8601 creation timestamp
 * @returns {Promise<object>} Created or existing message
 */
export async function addMessage(collections, message) {
  const { ap_messages } = collections;

  const result = await ap_messages.updateOne(
    { uid: message.uid },
    {
      $setOnInsert: {
        ...message,
        read: message.direction === "outbound" ? true : false,
      },
    },
    { upsert: true },
  );

  return await ap_messages.findOne({ uid: message.uid });
}

/**
 * Get messages with cursor-based pagination
 * @param {object} collections - MongoDB collections
 * @param {object} options - Query options
 * @param {string} [options.before] - Before cursor (published date ISO string)
 * @param {number} [options.limit=20] - Items per page
 * @param {string} [options.partner] - Filter by conversation partner (actorUrl)
 * @returns {Promise<object>} { items, before }
 */
export async function getMessages(collections, options = {}) {
  const { ap_messages } = collections;
  const parsedLimit = Number.parseInt(options.limit, 10);
  const limit = Math.min(
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20,
    100,
  );

  const query = {};

  // Filter by conversation partner
  if (options.partner) {
    query.conversationId = options.partner;
  }

  // Cursor pagination — published is ISO string, lexicographic comparison works
  if (options.before) {
    query.published = { $lt: options.before };
  }

  const rawItems = await ap_messages
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
 * Get conversation partners with last message date and unread count
 * @param {object} collections - MongoDB collections
 * @returns {Promise<Array>} Partners sorted by most recent message
 */
export async function getConversationPartners(collections) {
  const { ap_messages } = collections;

  const pipeline = [
    { $sort: { published: -1 } },
    {
      $group: {
        _id: "$conversationId",
        actorName: { $first: "$actorName" },
        actorPhoto: { $max: "$actorPhoto" },
        actorHandle: { $first: "$actorHandle" },
        lastMessage: { $max: "$published" },
        unreadCount: {
          $sum: { $cond: [{ $eq: ["$read", false] }, 1, 0] },
        },
      },
    },
    { $sort: { lastMessage: -1 } },
  ];

  return await ap_messages.aggregate(pipeline).toArray();
}

/**
 * Get count of unread messages
 * @param {object} collections - MongoDB collections
 * @returns {Promise<number>} Unread message count
 */
export async function getUnreadMessageCount(collections) {
  const { ap_messages } = collections;
  return await ap_messages.countDocuments({ read: false });
}

/**
 * Mark all messages from a partner as read
 * @param {object} collections - MongoDB collections
 * @param {string} actorUrl - Conversation partner's actor URL
 * @returns {Promise<object>} Update result
 */
export async function markMessagesRead(collections, actorUrl) {
  const { ap_messages } = collections;
  return await ap_messages.updateMany(
    { conversationId: actorUrl, read: false },
    { $set: { read: true } },
  );
}

/**
 * Mark all messages as read
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object>} Update result
 */
export async function markAllMessagesRead(collections) {
  const { ap_messages } = collections;
  return await ap_messages.updateMany({}, { $set: { read: true } });
}

/**
 * Delete a single message by UID
 * @param {object} collections - MongoDB collections
 * @param {string} uid - Message UID
 * @returns {Promise<object>} Delete result
 */
export async function deleteMessage(collections, uid) {
  const { ap_messages } = collections;
  return await ap_messages.deleteOne({ uid });
}

/**
 * Delete all messages
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object>} Delete result
 */
export async function clearAllMessages(collections) {
  const { ap_messages } = collections;
  return await ap_messages.deleteMany({});
}
