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
        // DD-3: `readAt` is the shared read state both surfaces observe.
        // `read` and `dismissed` are the M-1a dual-write, retained for one
        // release so a rollback needs no data restore.
        readAt: null,
        read: false,
        dismissed: false,
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







