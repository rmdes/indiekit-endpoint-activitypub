/**
 * Followed-hashtag domain logic.
 *
 * Tags are normalised to lowercase without a leading `#` at every entry point.
 * Doing it here rather than in each adapter is what stops "#IndieWeb" and
 * "indieweb" becoming two follows that neither surface can reconcile.
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
 * Every followed tag.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getFollowedTags(collections) {
  if (!collections.ap_followed_tags) return [];
  return collections.ap_followed_tags.find({}).sort({ tag: 1 }).toArray();
}

/**
 * Is this tag followed?
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<boolean>}
 */
export async function isTagFollowed(collections, tag) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) return false;

  return Boolean(await collections.ap_followed_tags.findOne({ tag: name }));
}

/**
 * Follow a tag. Idempotent.
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<string>} the normalised tag
 */
export async function followTag(collections, tag) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) return name;

  await collections.ap_followed_tags.updateOne(
    { tag: name },
    { $setOnInsert: { tag: name, createdAt: new Date().toISOString() } },
    { upsert: true },
  );

  return name;
}

/**
 * Unfollow a tag.
 *
 * @param {object} collections
 * @param {string} tag
 * @returns {Promise<string>} the normalised tag
 */
export async function unfollowTag(collections, tag) {
  const name = normaliseTag(tag);
  if (!name || !collections.ap_followed_tags) return name;

  await collections.ap_followed_tags.deleteOne({ tag: name });

  return name;
}
