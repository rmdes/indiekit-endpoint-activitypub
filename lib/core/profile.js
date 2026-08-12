/**
 * Local actor profile and instance-level counts.
 *
 * Small, but it removes the most-repeated adapter query in the codebase:
 * `ap_profile.findOne({})` appeared in the instance route, the timeline routes,
 * the moderation loader and several controllers.
 *
 * @module core/profile
 */

/**
 * The local actor's profile document.
 *
 * @param {object} collections
 * @returns {Promise<object|null>}
 */
export async function getProfile(collections) {
  if (!collections.ap_profile) return null;
  return collections.ap_profile.findOne({});
}

/**
 * Instance-level counts for NodeInfo and the Mastodon instance endpoint.
 *
 * @param {object} collections
 * @returns {Promise<{statusCount: number, followerCount: number, followingCount: number}>}
 */
export async function getInstanceStats(collections) {
  const [statusCount, followerCount, followingCount] = await Promise.all([
    collections.ap_timeline?.countDocuments({}) ?? 0,
    collections.ap_followers?.countDocuments({}) ?? 0,
    collections.ap_following?.countDocuments({}) ?? 0,
  ]);

  return { statusCount, followerCount, followingCount };
}

/**
 * Distinct instance domains among our followers.
 *
 * Approximate by design — it is a display statistic, not a ledger.
 *
 * @param {object} collections
 * @returns {Promise<number>}
 */
export async function countFollowerDomains(collections) {
  if (!collections.ap_followers) return 0;

  const rows = await collections.ap_followers
    .aggregate([
      { $match: { actorUrl: { $exists: true, $ne: null } } },
      { $group: { _id: "$actorUrl" } },
    ])
    .toArray();

  const domains = new Set();
  for (const row of rows) {
    try {
      domains.add(new URL(row._id).hostname);
    } catch {
      // A malformed stored actorUrl should not break a statistic.
    }
  }

  return domains.size;
}
