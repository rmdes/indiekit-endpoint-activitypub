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

// ─── The owner's publication (Indiekit's `posts` collection, JF2) ──────────
// Read-only views for the profile pages. Writes stay with Micropub.

/**
 * Number of posts in the publication.
 *
 * @param {object} collections - needs `posts`
 * @returns {Promise<number>}
 */
export async function countOwnPosts(collections) {
  if (!collections.posts) return 0;
  return collections.posts.countDocuments({});
}

/**
 * Publication posts, newest first, date-cursored.
 *
 * @param {object} collections - needs `posts`
 * @param {object} [options]
 * @param {string} [options.before] - ISO published date; strictly older
 * @param {number} [options.limit=20]
 * @param {string} [options.postType] - e.g. "reply"
 * @returns {Promise<object[]>} JF2 documents
 */
export async function getOwnPosts(collections, { before, limit = 20, postType } = {}) {
  if (!collections.posts) return [];

  const filter = {};
  if (postType) filter["properties.post-type"] = postType;
  if (before) filter["properties.published"] = { $lt: before };

  return collections.posts
    .find(filter)
    .sort({ "properties.published": -1 })
    .limit(limit)
    .toArray();
}

/**
 * A numbered page of publication posts, newest first.
 *
 * @param {object} collections - needs `posts`
 * @param {{skip?: number, limit?: number}} [page]
 * @returns {Promise<object[]>} JF2 documents
 */
export async function getOwnPostsPage(collections, { skip = 0, limit = 20 } = {}) {
  if (!collections.posts) return [];
  return collections.posts
    .find({})
    .sort({ "properties.published": -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/**
 * One publication post by its URL.
 *
 * @param {object} collections - needs `posts`
 * @param {string} url
 * @returns {Promise<object|null>}
 */
export async function getOwnPostByUrl(collections, url) {
  if (!collections.posts || !url) return null;
  return collections.posts.findOne({ "properties.url": url });
}

/**
 * Pinned (featured) post records, most recently pinned first.
 *
 * @param {object} collections - needs `ap_featured`
 * @returns {Promise<object[]>}
 */
export async function getFeaturedPins(collections) {
  if (!collections.ap_featured) return [];
  return collections.ap_featured.find({}).sort({ pinnedAt: -1 }).toArray();
}

/** Most posts the featured collection may hold. */
export const MAX_PINS = 5;

/**
 * Pin a post, up to MAX_PINS. Re-pinning an already pinned post refreshes it.
 *
 * @param {object} collections - needs `ap_featured`
 * @param {string} postUrl
 * @returns {Promise<{pinned: boolean, reason?: "limit"}>}
 */
export async function pinPost(collections, postUrl) {
  const { ap_featured } = collections;
  const already = await ap_featured.findOne({ postUrl });
  if (!already && (await ap_featured.countDocuments({})) >= MAX_PINS) {
    return { pinned: false, reason: "limit" };
  }

  await ap_featured.updateOne(
    { postUrl },
    { $set: { postUrl, pinnedAt: new Date().toISOString() } },
    { upsert: true },
  );
  return { pinned: true };
}

/**
 * Unpin a post.
 *
 * @param {object} collections - needs `ap_featured`
 * @param {string} postUrl
 * @returns {Promise<number>} documents removed
 */
export async function unpinPost(collections, postUrl) {
  const { deletedCount } = await collections.ap_featured.deleteOne({ postUrl });
  return deletedCount;
}
