/**
 * Timeline position markers.
 *
 * A marker is "how far this account had read in a given timeline", stored one
 * document per timeline name ("home", "notifications"). Clients use it to
 * restore scroll position across devices.
 *
 * Distinct from `readAt` (DD-3), which is per-item read state. A marker says
 * where you were; readAt says what you have seen. Both exist because Mastodon
 * clients expect markers and the reader wants per-item unread counts.
 *
 * @module core/markers
 */

/**
 * Markers for the named timelines.
 *
 * @param {object} collections
 * @param {string[]} timelines
 * @returns {Promise<Record<string, {last_read_id: string, version: number, updated_at: string}>>}
 */
export async function getMarkers(collections, timelines) {
  if (!collections.ap_markers || !timelines?.length) return {};

  const docs = await collections.ap_markers
    .find({ timeline: { $in: timelines } })
    .toArray();

  const result = {};
  for (const doc of docs) {
    result[doc.timeline] = {
      last_read_id: doc.last_read_id,
      version: doc.version || 0,
      updated_at: doc.updated_at || new Date().toISOString(),
    };
  }

  return result;
}

/**
 * Set the marker for one or more timelines.
 *
 * `version` increments on every write — Mastodon clients use it to detect a
 * marker moved by another device.
 *
 * @param {object} collections
 * @param {Record<string, {last_read_id: string}>} updates
 * @returns {Promise<Record<string, object>>} the resulting markers
 */
export async function setMarkers(collections, updates) {
  if (!collections.ap_markers) return {};

  const result = {};

  for (const [timeline, data] of Object.entries(updates)) {
    if (!data?.last_read_id) continue;

    const now = new Date().toISOString();

    await collections.ap_markers.updateOne(
      { timeline },
      {
        $set: { last_read_id: data.last_read_id, updated_at: now },
        $inc: { version: 1 },
        $setOnInsert: { timeline },
      },
      { upsert: true },
    );

    const doc = await collections.ap_markers.findOne({ timeline });
    result[timeline] = {
      last_read_id: doc.last_read_id,
      version: doc.version || 0,
      updated_at: doc.updated_at || now,
    };
  }

  return result;
}
