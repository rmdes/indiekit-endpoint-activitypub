/**
 * Simple in-memory LRU cache for lookupObject results
 * Max 100 entries, 5-minute TTL
 * @module lookup-cache
 */

const lookupCache = new Map();
const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get a cached lookup result
 * @param {string} url - URL key
 * @returns {*} Cached data or null
 */
export function getCached(url) {
  const entry = lookupCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    lookupCache.delete(url);
    return null;
  }
  return entry.data;
}

/**
 * Store a lookup result in cache
 * @param {string} url - URL key
 * @param {*} data - Data to cache
 */
export function setCache(url, data) {
  // Evict oldest entry if at max size
  if (lookupCache.size >= CACHE_MAX_SIZE) {
    const firstKey = lookupCache.keys().next().value;
    lookupCache.delete(firstKey);
  }
  lookupCache.set(url, { data, timestamp: Date.now() });
}
