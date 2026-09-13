/**
 * Redis-backed cache for plugin-level key-value storage.
 *
 * Replaces direct MongoDB ap_kv reads/writes for fedidb cache,
 * batch-refollow state, and migration flags. Uses the same Redis
 * connection as the Fedify message queue and KV store.
 *
 * All keys are prefixed with "indiekit:" to avoid collisions with
 * Fedify's "fedify::" prefix.
 */

import Redis from "ioredis";

const KEY_PREFIX = "indiekit:";

let _redis = null;

/**
 * Initialize the Redis cache with a connection URL.
 * Safe to call multiple times — reuses existing connection.
 * @param {string} redisUrl - Redis connection URL
 */
export function initRedisCache(redisUrl) {
  if (_redis) return;
  if (!redisUrl) return;
  _redis = new Redis(redisUrl);
}

/**
 * Get the Redis client instance (for direct use if needed).
 * @returns {import("ioredis").Redis|null}
 */
export function getRedisClient() {
  return _redis;
}

/**
 * Inject a client double (or null). Tests only — production calls initRedisCache.
 * @param {object|null} client
 */
export function setRedisClientForTesting(client) {
  _redis = client;
}

/**
 * Get a value from Redis cache.
 * @param {string} key
 * @returns {Promise<unknown|null>}
 */
export async function cacheGet(key) {
  if (!_redis) return null;
  try {
    const raw = await _redis.get(KEY_PREFIX + key);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Set a value in Redis cache with optional TTL.
 * @param {string} key
 * @param {unknown} value - Must be JSON-serializable
 * @param {number} [ttlSeconds] - Optional TTL in seconds (0 = no expiry)
 */
export async function cacheSet(key, value, ttlSeconds = 0) {
  if (!_redis) return;
  try {
    const raw = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await _redis.set(KEY_PREFIX + key, raw, "EX", ttlSeconds);
    } else {
      await _redis.set(KEY_PREFIX + key, raw);
    }
  } catch {
    // Cache write failure is non-critical
  }
}

/**
 * Delete a key from Redis cache.
 * @param {string} key
 */
export async function cacheDelete(key) {
  if (!_redis) return;
  try {
    await _redis.del(KEY_PREFIX + key);
  } catch {
    // Ignore
  }
}

/**
 * Check if a key exists in Redis cache.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function cacheExists(key) {
  if (!_redis) return false;
  try {
    return (await _redis.exists(KEY_PREFIX + key)) === 1;
  } catch {
    return false;
  }
}

/**
 * Cache-aside wrapper for query functions.
 * Returns cached result if available, otherwise runs queryFn and caches result.
 * @param {string} key - Cache key (without prefix — cacheGet/cacheSet add it)
 * @param {number} ttlSeconds - TTL in seconds
 * @param {Function} queryFn - Async function to run on cache miss
 * @returns {Promise<unknown>}
 */
export async function cachedQuery(key, ttlSeconds, queryFn) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const result = await queryFn();
  await cacheSet(key, result, ttlSeconds);
  return result;
}
