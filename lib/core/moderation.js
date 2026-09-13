/**
 * Moderation domain logic — the single implementation both surfaces call.
 *
 * `ap_muted` holds TWO shapes, keyed by which field is present:
 *   { url }      an account mute — enforced on the timeline via getMutedUrls()
 *   { keyword }  a keyword mute — matched against content
 *
 * AP-D9 came from an in-file comment asserting it held only keyword mutes,
 * which was false and contradicted by working code ~470 lines away in the same
 * module tree (routes/accounts.js builds `mutedIds` as `muted.filter(m => m.url)`
 * for the relationships endpoint). GET /api/v1/mutes returned [] on that
 * premise, so an account muted in the reader was invisible on the phone — and,
 * worse, a mute written by POST /accounts/:id/mute could not be read back by
 * the same API.
 *
 * These functions are the fix: one place that knows the collection holds both.
 *
 * WRITES go through lib/storage/{moderation,server-blocks}.js (core → storage,
 * the intended direction). Those do the side effects a write needs: invalidate
 * the 30 s moderation cache, keep the Redis blocked-server set in sync, and
 * normalise hostnames. Found 2026-09-13: this module used to write Mongo
 * directly and skipped all three — with Redis configured the inbox's
 * isServerBlocked reads only the Redis set, so a domain blocked from Phanpy
 * kept delivering until a restart.
 *
 * @module core/moderation
 */
import {
  addBlocked,
  addMuted,
  getAllBlocked,
  getFilterMode,
  removeBlocked,
  removeMuted,
  setFilterMode,
} from "../storage/moderation.js";
import {
  addBlockedServer,
  getAllBlockedServers,
  removeBlockedServer,
} from "../storage/server-blocks.js";

export { getFilterMode, setFilterMode };

/**
 * Account mutes — documents carrying a `url`.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getMutedAccounts(collections) {
  if (!collections.ap_muted) return [];
  return collections.ap_muted.find({ url: { $exists: true, $ne: null } }).toArray();
}

/**
 * Keyword mutes — documents carrying a `keyword`.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getMutedKeywords(collections) {
  if (!collections.ap_muted) return [];
  return collections.ap_muted
    .find({ keyword: { $exists: true, $ne: null } })
    .toArray();
}

/**
 * Mute an account or a keyword. Exactly one of `url`/`keyword` is required.
 *
 * @param {object} collections
 * @param {{url?: string, keyword?: string}} target
 * @returns {Promise<object>} the stored document
 */
export async function mute(collections, { url, keyword }) {
  if (!url && !keyword) {
    throw new TypeError("mute requires a url or a keyword");
  }

  return addMuted(collections, url ? { url } : { keyword });
}

/**
 * Remove a mute.
 *
 * @param {object} collections
 * @param {{url?: string, keyword?: string}} target
 * @returns {Promise<number>}
 */
export async function unmute(collections, { url, keyword }) {
  if (!url && !keyword) {
    throw new TypeError("unmute requires a url or a keyword");
  }

  const { deletedCount } = await removeMuted(collections, url ? { url } : { keyword });

  return deletedCount;
}

/**
 * Is this actor muted?
 *
 * @param {object} collections
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function isAccountMuted(collections, url) {
  if (!collections.ap_muted || !url) return false;
  return Boolean(await collections.ap_muted.findOne({ url }));
}

/**
 * Is an actor blocked?
 *
 * @param {object} collections
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function isAccountBlocked(collections, url) {
  if (!collections.ap_blocked || !url) return false;
  return Boolean(await collections.ap_blocked.findOne({ url }));
}

/**
 * Every blocked-account row that has a url.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getBlockedAccounts(collections) {
  if (!collections.ap_blocked) return [];
  return collections.ap_blocked.find({ url: { $exists: true } }).toArray();
}

/**
 * Blocked server hostnames.
 *
 * @param {object} collections
 * @returns {Promise<string[]>}
 */
export async function getBlockedServers(collections) {
  if (!collections.ap_blocked_servers) return [];
  const docs = await collections.ap_blocked_servers.find({}).toArray();
  return docs.map((d) => d.hostname).filter(Boolean);
}

/**
 * Block a server by hostname.
 *
 * @param {object} collections
 * @param {string} hostname
 * @returns {Promise<void>}
 */
export async function blockServer(collections, hostname, reason) {
  if (!hostname) throw new TypeError("blockServer requires a hostname");

  await addBlockedServer(collections, hostname, reason);
}

/**
 * Unblock a server.
 *
 * @param {object} collections
 * @param {string} hostname
 * @returns {Promise<number>}
 */
export async function unblockServer(collections, hostname) {
  if (!hostname) return 0;
  return removeBlockedServer(collections, hostname);
}

/**
 * Search followers and following by name, handle or URL.
 *
 * Lives here rather than in a search module because the corpus is the actor's
 * own relationships, which is moderation-adjacent data.
 *
 * @param {object} collections
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @returns {Promise<object[]>} deduplicated by actorUrl
 */
export async function searchRelationships(collections, query, { limit = 20 } = {}) {
  if (typeof query !== "string" || !query.trim()) return [];

  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");

  // Both field shapes exist in these collections: newer rows written by
  // approveFollow use actorUrl/handle, older ones carry preferredUsername/url.
  // Matching only one set silently halves the results.
  const filter = {
    $or: [
      { name: re },
      { handle: re },
      { actorUrl: re },
      { preferredUsername: re },
      { url: re },
    ],
  };

  const [followers, following] = await Promise.all([
    collections.ap_followers?.find(filter).limit(limit).toArray() ?? [],
    collections.ap_following?.find(filter).limit(limit).toArray() ?? [],
  ]);

  const byUrl = new Map();
  for (const row of [...followers, ...following]) {
    const key = row.actorUrl || row.url || row.id;
    if (key) byUrl.set(key, row);
  }

  return [...byUrl.values()].slice(0, limit);
}

/**
 * Mute an actor by URL. Idempotent.
 *
 * Thin wrapper over mute() with the account shape fixed, so adapters that only
 * ever mute accounts do not have to know ap_muted holds two shapes.
 *
 * @param {object} collections
 * @param {string} actorUrl
 * @returns {Promise<void>}
 */
export async function muteAccount(collections, actorUrl) {
  if (!actorUrl) return;
  await mute(collections, { url: actorUrl });
}

/**
 * Unmute an actor by URL.
 *
 * @param {object} collections
 * @param {string} actorUrl
 * @returns {Promise<number>}
 */
export async function unmuteAccount(collections, actorUrl) {
  if (!actorUrl) return 0;
  return unmute(collections, { url: actorUrl });
}

/**
 * Block an actor by URL. Idempotent.
 *
 * @param {object} collections
 * @param {string} actorUrl
 * @returns {Promise<void>}
 */
export async function blockAccount(collections, actorUrl) {
  if (!actorUrl || !collections.ap_blocked) return;

  await addBlocked(collections, actorUrl);
}

/**
 * Unblock an actor by URL.
 *
 * @param {object} collections
 * @param {string} actorUrl
 * @returns {Promise<number>}
 */
export async function unblockAccount(collections, actorUrl) {
  if (!actorUrl || !collections.ap_blocked) return 0;

  const { deletedCount } = await removeBlocked(collections, actorUrl);
  return deletedCount;
}

/**
 * All ap_muted rows, both shapes — callers that need to distinguish account
 * mutes from keyword mutes themselves (the relationships endpoint does).
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getAllMutedRows(collections) {
  if (!collections.ap_muted) return [];
  return collections.ap_muted.find({}).toArray();
}

/**
 * Blocked-server documents, not just hostnames.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getBlockedServerRows(collections) {
  if (!collections.ap_blocked_servers) return [];
  return getAllBlockedServers(collections); // newest block first
}

/**
 * All ap_blocked rows (the reader's moderation page lists them).
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getBlockedAccountRows(collections) {
  if (!collections.ap_blocked) return [];
  return getAllBlocked(collections);
}
