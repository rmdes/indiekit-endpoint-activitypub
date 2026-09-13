/**
 * Server-level blocking storage operations.
 * Blocks entire instances by hostname, checked in inbox listeners
 * before any expensive work is done.
 * @module storage/server-blocks
 */

import { getRedisClient } from "../redis-cache.js";

const REDIS_KEY = "indiekit:blocked_servers";

/**
 * Add a server block by hostname.
 * @param {object} collections - MongoDB collections
 * @param {string} hostname - Hostname to block (lowercase, no protocol)
 * @param {string} [reason] - Optional admin note
 */
export async function addBlockedServer(collections, hostname, reason) {
  const { ap_blocked_servers } = collections;
  const normalized = hostname.toLowerCase().trim();

  await ap_blocked_servers.updateOne(
    { hostname: normalized },
    {
      $setOnInsert: {
        hostname: normalized,
        blockedAt: new Date().toISOString(),
        ...(reason ? { reason } : {}),
      },
    },
    { upsert: true },
  );

  // Incremental Redis update
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.sadd(REDIS_KEY, normalized);
    } catch {
      // Non-critical
    }
  }
}

/**
 * Remove a server block by hostname.
 * @param {object} collections - MongoDB collections
 * @param {string} hostname - Hostname to unblock
 */
export async function removeBlockedServer(collections, hostname) {
  const { ap_blocked_servers } = collections;
  const normalized = hostname.toLowerCase().trim();

  const { deletedCount } = await ap_blocked_servers.deleteOne({ hostname: normalized });

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.srem(REDIS_KEY, normalized);
    } catch {
      // Non-critical
    }
  }

  return deletedCount;
}

/**
 * Get all blocked servers.
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object[]>} Array of block entries
 */
export async function getAllBlockedServers(collections) {
  const { ap_blocked_servers } = collections;
  return await ap_blocked_servers.find({}).sort({ blockedAt: -1 }).toArray();
}

/**
 * Check if a server is blocked by actor URL.
 * Uses Redis Set (O(1)) with MongoDB fallback.
 * @param {string} actorUrl - Full actor URL
 * @param {object} collections - MongoDB collections (fallback only)
 * @returns {Promise<boolean>}
 */
export async function isServerBlocked(actorUrl, collections) {
  if (!actorUrl) return false;
  try {
    const hostname = new URL(actorUrl).hostname.toLowerCase();
    const redis = getRedisClient();
    if (redis) {
      return (await redis.sismember(REDIS_KEY, hostname)) === 1;
    }
    // Fallback: direct MongoDB check
    const { ap_blocked_servers } = collections;
    return !!(await ap_blocked_servers.findOne({ hostname }));
  } catch {
    return false;
  }
}

/**
 * Load all blocked hostnames into Redis Set on startup.
 * Replaces existing set contents entirely.
 * @param {object} collections - MongoDB collections
 */
export async function loadBlockedServersToRedis(collections) {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const { ap_blocked_servers } = collections;
    const docs = await ap_blocked_servers.find({}).toArray();
    const hostnames = docs.map((d) => d.hostname);

    // Replace: delete existing set, then add all
    await redis.del(REDIS_KEY);
    if (hostnames.length > 0) {
      await redis.sadd(REDIS_KEY, ...hostnames);
    }
  } catch {
    // Non-critical — isServerBlocked falls back to MongoDB
  }
}
