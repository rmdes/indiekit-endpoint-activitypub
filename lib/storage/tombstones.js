/**
 * Tombstone storage for soft-deleted posts (FEP-4f05).
 * When a post is deleted, a tombstone record is created so remote servers
 * fetching the URL get a proper Tombstone response instead of 404.
 * @module storage/tombstones
 */

/**
 * Record a tombstone for a deleted post.
 * @param {object} collections - MongoDB collections
 * @param {object} data - { url, formerType, published, deleted }
 */
export async function addTombstone(collections, { url, formerType, published, deleted }) {
  const { ap_tombstones } = collections;
  if (!ap_tombstones) return;

  await ap_tombstones.updateOne(
    { url },
    {
      $set: {
        url,
        formerType: formerType || "Note",
        published: published || null,
        deleted: deleted || new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

/**
 * Remove a tombstone (post re-published).
 * @param {object} collections - MongoDB collections
 * @param {string} url - Post URL
 */
export async function removeTombstone(collections, url) {
  const { ap_tombstones } = collections;
  if (!ap_tombstones) return;
  await ap_tombstones.deleteOne({ url });
}

/**
 * Look up a tombstone by URL.
 * @param {object} collections - MongoDB collections
 * @param {string} url - Post URL
 * @returns {Promise<object|null>} Tombstone record or null
 */
export async function getTombstone(collections, url) {
  const { ap_tombstones } = collections;
  if (!ap_tombstones) return null;
  return ap_tombstones.findOne({ url });
}
