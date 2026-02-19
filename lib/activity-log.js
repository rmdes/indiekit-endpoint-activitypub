/**
 * Shared activity logging utility.
 *
 * Logs inbound and outbound ActivityPub activities to the ap_activities
 * collection so they appear in the Activity Log admin UI.
 */

/**
 * Log an activity to the ap_activities collection.
 *
 * @param {object} collection - The ap_activities MongoDB collection
 * @param {object} record - Activity record
 * @param {string} record.direction - "inbound" or "outbound"
 * @param {string} record.type - Activity type (e.g. "Create", "Follow", "Undo(Follow)")
 * @param {string} [record.actorUrl] - Actor URL
 * @param {string} [record.actorName] - Actor display name
 * @param {string} [record.objectUrl] - Object URL
 * @param {string} [record.targetUrl] - Target URL (e.g. reply target)
 * @param {string} [record.content] - Content excerpt
 * @param {string} record.summary - Human-readable summary
 */
export async function logActivity(collection, record) {
  try {
    await collection.insertOne({
      ...record,
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[ActivityPub] Failed to log activity:", error.message);
  }
}
