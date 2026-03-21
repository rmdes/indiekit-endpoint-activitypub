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
 * Get all followed hashtags with full state (local + global follow tracking)
 * @param {object} collections - MongoDB collections
 * @returns {Promise<Array<{tag: string, followedAt?: string, globalFollow?: boolean, globalActorUrl?: string}>>}
 */
export async function getFollowedTagsWithState(collections) {
  const { ap_followed_tags } = collections;
  if (!ap_followed_tags) return [];
  return ap_followed_tags.find({}).sort({ followedAt: -1 }).toArray();
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
 * Unfollow a hashtag locally.
 * If a global follow (tags.pub) is active, preserves the document with global state intact.
 * Only deletes the document entirely when no global follow is active.
 * @param {object} collections - MongoDB collections
 * @param {string} tag - Hashtag string (without # prefix)
 * @returns {Promise<boolean>} true if removed/updated, false if not found
 */
export async function unfollowTag(collections, tag) {
  const { ap_followed_tags } = collections;
  const normalizedTag = tag.toLowerCase().trim().replace(/^#/, "");
  if (!normalizedTag) return false;

  // Check if a global follow is active before deleting
  const existing = await ap_followed_tags.findOne({ tag: normalizedTag });
  if (!existing) return false;

  if (existing.globalFollow) {
    // Preserve the document — only unset the local follow fields
    await ap_followed_tags.updateOne(
      { tag: normalizedTag },
      { $unset: { followedAt: "" } }
    );
    return true;
  }

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
  return !!(doc?.followedAt);
}

/**
 * Returns the deterministic tags.pub actor URL for a hashtag.
 * @param {string} tag - Hashtag string (without # prefix)
 * @returns {string} Actor URL
 */
export function getTagsPubActorUrl(tag) {
  return `https://tags.pub/user/${tag.toLowerCase().replace(/^#/, "")}`;
}

/**
 * Set global follow state for a hashtag (upsert — works even with no local follow).
 * @param {object} collections - MongoDB collections
 * @param {string} tag - Hashtag string (without # prefix)
 * @param {string} actorUrl - The tags.pub actor URL
 * @returns {Promise<void>}
 */
export async function setGlobalFollow(collections, tag, actorUrl) {
  const { ap_followed_tags } = collections;
  const normalizedTag = tag.toLowerCase().trim().replace(/^#/, "");
  if (!normalizedTag) return;

  await ap_followed_tags.updateOne(
    { tag: normalizedTag },
    {
      $set: { globalFollow: true, globalActorUrl: actorUrl },
      $setOnInsert: { tag: normalizedTag },
    },
    { upsert: true }
  );
}

/**
 * Remove global follow state for a hashtag.
 * If no local follow exists (no followedAt), deletes the document entirely.
 * @param {object} collections - MongoDB collections
 * @param {string} tag - Hashtag string (without # prefix)
 * @returns {Promise<void>}
 */
export async function removeGlobalFollow(collections, tag) {
  const { ap_followed_tags } = collections;
  const normalizedTag = tag.toLowerCase().trim().replace(/^#/, "");
  if (!normalizedTag) return;

  const existing = await ap_followed_tags.findOne({ tag: normalizedTag });
  if (!existing) return;

  if (existing.followedAt) {
    // Local follow is still active — just unset the global fields
    await ap_followed_tags.updateOne(
      { tag: normalizedTag },
      { $unset: { globalFollow: "", globalActorUrl: "" } }
    );
  } else {
    // No local follow — delete the document entirely
    await ap_followed_tags.deleteOne({ tag: normalizedTag });
  }
}
