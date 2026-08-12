/**
 * Post lifecycle — delete, edit, edit history, idempotency.
 *
 * Creation is NOT here. A new post goes through the Micropub endpoint and the
 * syndicator, which own JF2→AS2 conversion and delivery; duplicating that path
 * would be the exact mistake this refactor exists to undo. What lives here is
 * what happens to a post that already exists.
 *
 * @module core/posts
 */
import { decodeCursor } from "./cursor.js";

/**
 * Look up a cached response for an Idempotency-Key.
 *
 * Mastodon clients retry a failed POST with the same key; without this a flaky
 * connection posts twice.
 *
 * @param {object} collections
 * @param {string} key
 * @returns {Promise<object|null>} the cached response body, or null
 */
export async function getIdempotent(collections, key) {
  if (!key || !collections.ap_idempotency) return null;

  const cached = await collections.ap_idempotency.findOne({ key });
  return cached?.response || null;
}

/**
 * Cache a response against an Idempotency-Key.
 *
 * @param {object} collections
 * @param {string} key
 * @param {object} response
 * @returns {Promise<void>}
 */
export async function setIdempotent(collections, key, response) {
  if (!key || !collections.ap_idempotency) return;

  await collections.ap_idempotency.updateOne(
    { key },
    { $set: { key, response, createdAt: new Date().toISOString() } },
    { upsert: true },
  );
}

/**
 * Delete a post and everything keyed to it.
 *
 * Interactions go too: a like or boost record pointing at a deleted post would
 * keep the item marked "favourited" for any client that still holds its id.
 *
 * @param {object} collections
 * @param {object} item - the timeline document
 * @returns {Promise<{deleted: number, interactions: number}>}
 */
export async function deletePost(collections, item) {
  if (!item?._id || !collections.ap_timeline) {
    return { deleted: 0, interactions: 0 };
  }

  const { deletedCount } = await collections.ap_timeline.deleteOne({
    _id: item._id,
  });

  let interactions = 0;
  if (item.uid && collections.ap_interactions) {
    ({ deletedCount: interactions } = await collections.ap_interactions.deleteMany({
      objectUrl: item.uid,
    }));
  }

  return { deleted: deletedCount, interactions };
}

/**
 * Record the pre-edit state of a post, so an edit history can be served.
 *
 * @param {object} collections
 * @param {object} snapshot - { statusUid, content, summary, sensitive, editedAt }
 * @returns {Promise<void>}
 */
export async function recordEdit(collections, snapshot) {
  if (!collections.ap_status_edits) return;

  await collections.ap_status_edits.insertOne({
    ...snapshot,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Edit history for a post, oldest first.
 *
 * @param {object} collections
 * @param {string} statusUid
 * @returns {Promise<object[]>}
 */
export async function getEditHistory(collections, statusUid) {
  if (!statusUid || !collections.ap_status_edits) return [];

  return collections.ap_status_edits
    .find({ statusUid })
    .sort({ createdAt: 1 })
    .toArray();
}

/**
 * Apply an edit to a stored post.
 *
 * @param {object} collections
 * @param {string} id - opaque id of the timeline document
 * @param {object} updates
 * @returns {Promise<object|null>} the updated document
 */
export async function updatePost(collections, id, updates) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_timeline) return null;

  await collections.ap_timeline.updateOne({ _id: objectId }, { $set: updates });

  return collections.ap_timeline.findOne({ _id: objectId });
}

/**
 * Edit history for a post, oldest first, keyed by the adapter's status id.
 *
 * Kept separate from getEditHistory (which keys on the AP uid) because the
 * Mastodon API addresses edits by its own status id, and the stored documents
 * were written with that key.
 *
 * @param {object} collections
 * @param {string} statusId
 * @returns {Promise<object[]>}
 */
export async function getEditHistoryByStatusId(collections, statusId) {
  if (!statusId || !collections.ap_status_edits) return [];

  return collections.ap_status_edits
    .find({ statusId })
    .sort({ createdAt: 1 })
    .toArray();
}
