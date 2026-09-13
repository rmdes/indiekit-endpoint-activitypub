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

/**
 * Every follower document.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getFollowers(collections) {
  if (!collections.ap_followers) return [];
  return collections.ap_followers.find({}).toArray();
}

/**
 * Do we follow this actor?
 *
 * @param {object} collections
 * @param {string} actorUrl
 * @returns {Promise<boolean>}
 */
export async function isFollowing(collections, actorUrl) {
  if (!collections.ap_following || !actorUrl) return false;
  return Boolean(await collections.ap_following.findOne({ actorUrl }));
}

/**
 * One page of followers, most recent first.
 *
 * @param {object} collections
 * @param {{skip?: number, limit?: number}} [page]
 * @returns {Promise<object[]>}
 */
export async function getFollowersPage(collections, { skip = 0, limit = 20 } = {}) {
  if (!collections.ap_followers) return [];
  return collections.ap_followers
    .find({})
    .sort({ followedAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/**
 * Counts for the admin dashboard and profile pages. Missing collections count 0.
 *
 * @param {object} collections
 * @returns {Promise<{followers: number, following: number, featured: number, featuredTags: number}>}
 */
export async function getAccountCounts(collections) {
  const n = (col) => col?.countDocuments({}) ?? 0;
  const [followers, following, featured, featuredTags] = await Promise.all([
    n(collections.ap_followers),
    n(collections.ap_following),
    n(collections.ap_featured),
    n(collections.ap_featured_tags),
  ]);
  return { followers, following, featured, featuredTags };
}

/**
 * Document counts for a list of collections (the federation admin page).
 * A missing collection counts 0.
 *
 * @param {object} collections - keyed by collection name
 * @param {string[]} names
 * @returns {Promise<Array<{name: string, count: number}>>}
 */
export async function countCollections(collections, names) {
  return Promise.all(
    names.map(async (name) => ({
      name,
      count: (await collections[name]?.countDocuments({})) ?? 0,
    })),
  );
}

/**
 * Most recent entries in the activity log.
 *
 * @param {object} collections
 * @param {{limit?: number}} [options]
 * @returns {Promise<object[]>}
 */
export async function getRecentActivities(collections, { limit = 10 } = {}) {
  if (!collections.ap_activities) return [];
  return collections.ap_activities.find({}).sort({ receivedAt: -1 }).limit(limit).toArray();
}

/**
 * Every following document.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getFollowing(collections) {
  if (!collections.ap_following) return [];
  return collections.ap_following.find({}).toArray();
}

/**
 * Distinct authors seen in the timeline — the pool for account lookups that
 * are neither a follower nor followed.
 *
 * @param {object} collections
 * @param {object} [options]
 * @param {number} [options.limit=200]
 * @returns {Promise<object[]>} author sub-documents
 */
export async function getKnownAuthors(collections, { limit = 200 } = {}) {
  if (!collections.ap_timeline) return [];

  const rows = await collections.ap_timeline
    .aggregate([
      { $match: { "author.url": { $exists: true, $ne: null } } },
      { $group: { _id: "$author.url", author: { $first: "$author" } } },
      { $limit: limit },
    ])
    .toArray();

  return rows.map((r) => r.author).filter(Boolean);
}

/**
 * Posts authored by one actor.
 *
 * @param {object} collections
 * @param {string} authorUrl
 * @returns {Promise<number>}
 */
export async function countAuthorPosts(collections, authorUrl) {
  if (!collections.ap_timeline || !authorUrl) return 0;
  return collections.ap_timeline.countDocuments({ "author.url": authorUrl });
}

/**
 * Status/follower/following counts for one actor.
 *
 * @param {object} collections
 * @param {string} authorUrl
 * @returns {Promise<{statusCount: number, followerCount: number, followingCount: number}>}
 */
export async function getActorStats(collections, authorUrl) {
  const [statusCount, followerCount, followingCount] = await Promise.all([
    countAuthorPosts(collections, authorUrl),
    collections.ap_followers?.countDocuments({}) ?? 0,
    collections.ap_following?.countDocuments({}) ?? 0,
  ]);

  return { statusCount, followerCount, followingCount };
}

/**
 * Update the local actor's profile.
 *
 * The collection holds exactly one document, hence the empty filter — that is
 * the existing shape, not a bug. Upserts, as the reader's forms always did: the
 * Mastodon path used not to, so an edit before the profile was seeded vanished.
 *
 * @param {object} collections
 * @param {object} update - fields to $set
 * @returns {Promise<void>}
 */
export async function updateProfile(collections, update) {
  if (!collections.ap_profile || !update || Object.keys(update).length === 0) {
    return;
  }

  await collections.ap_profile.updateOne({}, { $set: update }, { upsert: true });
}

/**
 * Follower/following documents matching a set of actor URLs.
 *
 * @param {object} collections
 * @param {string[]} actorUrls
 * @returns {Promise<Map<string, object>>} keyed by actorUrl
 */
export async function getRelationshipsByUrls(collections, actorUrls) {
  const known = new Map();
  const urls = [...new Set((actorUrls || []).filter(Boolean))];
  if (urls.length === 0) return known;

  for (const collection of [collections.ap_followers, collections.ap_following]) {
    if (!collection) continue;

    const docs = await collection.find({ actorUrl: { $in: urls } }).toArray();
    for (const doc of docs) {
      if (!known.has(doc.actorUrl)) known.set(doc.actorUrl, doc);
    }
  }

  return known;
}

/**
 * Find a follower by handle, with or without a leading "@".
 *
 * Kept separate from the following/author lookups rather than collapsed into
 * one: each call site serialises its result differently (a follower carries a
 * banner, a timeline author is already an author sub-document), so a single
 * function would have to lose information or return a tagged union for no gain.
 *
 * @param {object} collections
 * @param {string} bareAcct - handle without a leading "@"
 * @returns {Promise<object|null>}
 */
export async function findFollowerByHandle(collections, bareAcct) {
  if (!collections.ap_followers || !bareAcct) return null;

  return collections.ap_followers.findOne({
    $or: [{ handle: `@${bareAcct}` }, { handle: bareAcct }],
  });
}

/**
 * Find a followed actor by handle.
 *
 * @param {object} collections
 * @param {string} bareAcct
 * @returns {Promise<object|null>}
 */
export async function findFollowingByHandle(collections, bareAcct) {
  if (!collections.ap_following || !bareAcct) return null;

  return collections.ap_following.findOne({
    $or: [{ handle: `@${bareAcct}` }, { handle: bareAcct }],
  });
}

/**
 * Find an author by handle among the posts we hold.
 *
 * @param {object} collections
 * @param {string} bareAcct
 * @returns {Promise<object|null>} the author sub-document
 */
export async function findAuthorByHandle(collections, bareAcct) {
  if (!collections.ap_timeline || !bareAcct) return null;

  const item = await collections.ap_timeline.findOne({
    "author.handle": { $in: [`@${bareAcct}`, bareAcct] },
  });

  return item?.author || null;
}
