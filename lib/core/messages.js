/**
 * Direct-message domain logic.
 *
 * `conversationId` is the other party's actor URL, so a conversation is
 * exactly the messages exchanged with one actor — no separate thread identity
 * to maintain.
 *
 * AP-D6′: GET /api/v1/conversations returned [] while the reader had a full DM
 * UI over the same collection. This module is what both now read.
 *
 * @module core/messages
 */

/**
 * Conversations, most recently active first, each with its latest message.
 *
 * Done as one aggregation rather than a group-then-N-lookups: `$group` with
 * `$first` after a `$sort` gives both the summary and the latest document in a
 * single pass.
 *
 * @param {object} collections
 * @param {object} [options]
 * @param {number} [options.limit=40]
 * @returns {Promise<object[]>} { conversationId, actorUrl, actorName,
 *   actorHandle, actorPhoto, unreadCount, lastMessage }
 */
export async function getConversations(collections, { limit = 40 } = {}) {
  if (!collections.ap_messages) return [];

  const rows = await collections.ap_messages
    .aggregate([
      { $sort: { published: -1 } },
      {
        $group: {
          _id: "$conversationId",
          actorUrl: { $first: "$actorUrl" },
          actorName: { $first: "$actorName" },
          actorHandle: { $first: "$actorHandle" },
          actorPhoto: { $max: "$actorPhoto" },
          lastMessage: { $first: "$$ROOT" },
          lastActivity: { $max: "$published" },
          unreadCount: {
            $sum: { $cond: [{ $eq: ["$read", false] }, 1, 0] },
          },
        },
      },
      { $sort: { lastActivity: -1 } },
      { $limit: limit },
    ])
    .toArray();

  return rows.map((row) => ({
    conversationId: row._id,
    actorUrl: row.actorUrl || row._id,
    actorName: row.actorName || "",
    actorHandle: row.actorHandle || "",
    actorPhoto: row.actorPhoto || "",
    unreadCount: row.unreadCount || 0,
    lastActivity: row.lastActivity,
    lastMessage: row.lastMessage,
  }));
}

/**
 * Messages in one conversation, oldest first.
 *
 * @param {object} collections
 * @param {string} conversationId - the other party's actor URL
 * @param {object} [options]
 * @param {number} [options.limit=100]
 * @returns {Promise<object[]>}
 */
export async function getConversation(collections, conversationId, { limit = 100 } = {}) {
  if (!collections.ap_messages || !conversationId) return [];

  return collections.ap_messages
    .find({ conversationId })
    .sort({ published: 1 })
    .limit(limit)
    .toArray();
}

/**
 * Mark a conversation read.
 *
 * @param {object} collections
 * @param {string} conversationId
 * @returns {Promise<number>}
 */
export async function markConversationRead(collections, conversationId) {
  if (!collections.ap_messages || !conversationId) return 0;

  const { modifiedCount } = await collections.ap_messages.updateMany(
    { conversationId, read: false },
    { $set: { read: true } },
  );

  return modifiedCount;
}

/**
 * Count unread messages across all conversations.
 *
 * @param {object} collections
 * @returns {Promise<number>}
 */
export async function countUnread(collections) {
  if (!collections.ap_messages) return 0;
  return collections.ap_messages.countDocuments({ read: false });
}
