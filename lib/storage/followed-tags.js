/**
 * Followed hashtag storage operations
 * @module storage/followed-tags
 */

/**
 * Get all followed hashtags
 * @param {object} collections - MongoDB collections
 * @returns {Promise<string[]>} Array of tag strings (lowercase)
 */
export async function getFollowedTags(collections) {
  const { ap_followed_tags } = collections;
  if (!ap_followed_tags) return [];
  const docs = await ap_followed_tags.find({}).sort({ followedAt: -1 }).toArray();
  return docs.map((d) => d.tag);
}

/**
 * Follow a hashtag
 * @param {object} collections - MongoDB collections
 * @param {string} tag - Hashtag string (without # prefix)
 * @returns {Promise<boolean>} true if newly added, false if already following
 */
export async function followTag(collections, tag) {
  const { ap_followed_tags } = collections;
  const normalizedTag = tag.toLowerCase().trim().replace(/^#/, "");
  if (!normalizedTag) return false;

  const result = await ap_followed_tags.updateOne(
    { tag: normalizedTag },
    { $setOnInsert: { tag: normalizedTag, followedAt: new Date().toISOString() } },
    { upsert: true }
  );

  return result.upsertedCount > 0;
}

/**
 * Unfollow a hashtag
 * @param {object} collections - MongoDB collections
 * @param {string} tag - Hashtag string (without # prefix)
 * @returns {Promise<boolean>} true if removed, false if not found
 */
export async function unfollowTag(collections, tag) {
  const { ap_followed_tags } = collections;
  const normalizedTag = tag.toLowerCase().trim().replace(/^#/, "");
  if (!normalizedTag) return false;

  const result = await ap_followed_tags.deleteOne({ tag: normalizedTag });
  return result.deletedCount > 0;
}

/**
 * Check if a specific hashtag is followed
 * @param {object} collections - MongoDB collections
 * @param {string} tag - Hashtag string (without # prefix)
 * @returns {Promise<boolean>}
 */
export async function isTagFollowed(collections, tag) {
  const { ap_followed_tags } = collections;
  if (!ap_followed_tags) return false;
  const normalizedTag = tag.toLowerCase().trim().replace(/^#/, "");
  const doc = await ap_followed_tags.findOne({ tag: normalizedTag });
  return !!doc;
}
