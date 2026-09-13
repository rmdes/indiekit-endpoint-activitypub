/**
 * Followed-hashtag domain logic.
 *
 * Tags are normalised to lowercase without a leading `#` at every entry point.
 * Doing it here rather than in each adapter is what stops "#IndieWeb" and
 * "indieweb" becoming two follows that neither surface can reconcile.
 *
 * A tag has two INDEPENDENT follow states on one document:
 *   followedAt    — local follow: inbox posts carrying the tag enter the timeline
 *   globalFollow  — a Follow sent to the tags.pub relay actor (globalActorUrl)
 * Removing one keeps the other; the document goes only when both are gone.
 *
 * This module used to be a lossy copy of lib/storage/followed-tags.js (it wrote
 * `createdAt`, ignored `globalFollow`, and deleted on unfollow), so the two
 * lanes disagreed about which tags were followed. That storage module is gone;
 * rows the old copy wrote are repaired by migrations/single-lane-core.js
 * #backfillTagFollowedAt.
 *
 * @module core/tags
 */

/**
 * Normalise a tag to its stored form.
 *
 * @param {string} tag
 * @returns {string}
 */
export function normaliseTag(tag) {
  if (typeof tag !== "string") return "";
  return tag.trim().toLowerCase().replace(/^#/, "");
}

/**
 * Every tag with any follow state, most recently followed first.
 *
 * @param {object} collections
 * @returns {Promise<Array<{tag: string, followedAt?: string, globalFollow?: boolean, globalActorUrl?: string}>>}
 */
export async function getFollowedTags(collections) {
  if (!collections.ap_followed_tags) return [];
  return collections.ap_followed_tags
    .find({})
    .sort({ followedAt: -1, tag: 1 })
    .toArray();
}

/**
 * Both follow states for one tag.
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<{following: boolean, globalFollow: boolean}>}
 */
export async function getTagFollowState(collections, tag) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) {
    return { following: false, globalFollow: false };
  }

  const doc = await collections.ap_followed_tags.findOne({ tag: name });
  return { following: Boolean(doc?.followedAt), globalFollow: Boolean(doc?.globalFollow) };
}

/**
 * Is the tag followed LOCALLY? A global-only (tags.pub) follow is not.
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<boolean>}
 */
export async function isTagFollowed(collections, tag) {
  return (await getTagFollowState(collections, tag)).following;
}

/**
 * Follow a tag locally. Idempotent; keeps the original followedAt.
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<string>} the normalised tag ("" if unusable)
 */
export async function followTag(collections, tag) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) return name;

  // Two steps so neither depends on the unique `tag` index to stay single:
  // ensure the document, then stamp followedAt only if absent.
  await collections.ap_followed_tags.updateOne(
    { tag: name },
    { $setOnInsert: { tag: name } },
    { upsert: true },
  );
  await collections.ap_followed_tags.updateOne(
    { tag: name, followedAt: { $exists: false } },
    { $set: { followedAt: new Date().toISOString() } },
  );

  return name;
}

/**
 * Remove the local follow. An active global follow keeps the document.
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<string>} the normalised tag
 */
export async function unfollowTag(collections, tag) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) return name;

  await collections.ap_followed_tags.deleteOne({ tag: name, globalFollow: { $ne: true } });
  await collections.ap_followed_tags.updateOne(
    { tag: name, globalFollow: true },
    { $unset: { followedAt: "" } },
  );

  return name;
}

/**
 * The tags.pub relay actor for a tag.
 *
 * @param {string} tag
 * @returns {string}
 */
export function getTagsPubActorUrl(tag) {
  return `https://tags.pub/user/${normaliseTag(tag)}`;
}

/**
 * Record a global (tags.pub) follow. Sending the Follow is the caller's job.
 *
 * @param {object} collections
 * @param {string} tag
 * @param {string} actorUrl
 * @returns {Promise<void>}
 */
export async function setGlobalFollow(collections, tag, actorUrl) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) return;

  await collections.ap_followed_tags.updateOne(
    { tag: name },
    { $set: { globalFollow: true, globalActorUrl: actorUrl }, $setOnInsert: { tag: name } },
    { upsert: true },
  );
}

/**
 * Remove the global follow record. An active local follow keeps the document.
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<void>}
 */
export async function removeGlobalFollow(collections, tag) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) return;

  await collections.ap_followed_tags.deleteOne({ tag: name, followedAt: { $exists: false } });
  await collections.ap_followed_tags.updateOne(
    { tag: name, followedAt: { $exists: true } },
    { $unset: { globalFollow: "", globalActorUrl: "" } },
  );
}
