/**
 * In-memory cache for remote account stats (followers, following, statuses).
 *
 * Populated by resolveRemoteAccount() when a profile is fetched.
 * Read by serializeAccount() to enrich embedded account objects in statuses.
 *
 * LRU-style with TTL — entries expire after 1 hour.
 */

import { remoteActorId } from "./id-mapping.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 500;

// Map<actorUrl, { followersCount, followingCount, statusesCount, createdAt, cachedAt }>
const cache = new Map();

// Reverse map: accountId (hash) → actorUrl
// Populated alongside the stats cache for follow/unfollow lookups
const idToUrl = new Map();

/**
 * Store account stats in cache.
 * @param {string} actorUrl - The actor's URL (cache key)
 * @param {object} stats - { followersCount, followingCount, statusesCount, createdAt }
 */
export function cacheAccountStats(actorUrl, stats) {
  if (!actorUrl) return;

  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }

  cache.set(actorUrl, { ...stats, cachedAt: Date.now() });

  // Maintain reverse lookup
  const hashId = remoteActorId(actorUrl);
  if (hashId) idToUrl.set(hashId, actorUrl);
}

/**
 * Get cached account stats.
 * @param {string} actorUrl - The actor's URL
 * @returns {object|null} Stats or null if not cached/expired
 */
export function getCachedAccountStats(actorUrl) {
  if (!actorUrl) return null;

  const entry = cache.get(actorUrl);
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(actorUrl);
    return null;
  }

  return entry;
}

/**
 * Reverse lookup: get actor URL from account hash ID.
 * @param {string} hashId - The 24-char hex account ID
 * @returns {string|null} Actor URL or null
 */
export function getActorUrlFromId(hashId) {
  return idToUrl.get(hashId) || null;
}
