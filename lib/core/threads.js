/**
 * Thread reconstruction — the single implementation both surfaces call.
 *
 * Replaces:
 *   lib/controllers/post-detail.js#loadParentChain    (reader: remote fetch, maxDepth 5)
 *   lib/mastodon/routes/statuses.js GET /:id/context  (Mastodon: local only, cap 40)
 *
 * AP-D4: those disagreed in both directions. The reader had the better
 * MECHANISM — it fetches missing ancestors from the origin server — but the
 * shallower DEFAULT, so on a long local thread it showed FEWER ancestors than
 * the Mastodon lane. Measured before the port: reader 5, Mastodon 6.
 *
 * Resolution: keep the remote fetch, raise the default off 5, and give both
 * surfaces one depth and one timeout.
 *
 * @module core/threads
 */
import { getCached, setCache } from "../lookup-cache.js";
import { lookupWithSecurity } from "../lookup-helpers.js";
import { extractObjectData } from "../timeline-store.js";

/**
 * How far up a reply chain to walk.
 *
 * 40 matches what the Mastodon lane already did and what Mastodon itself
 * returns, so no client sees a shorter thread than before. The reader's old
 * default of 5 was the lower of the two and had no stated rationale.
 */
export const MAX_ANCESTORS = 40;

/** Direct + nested replies to return. Matches the Mastodon lane's prior cap. */
export const MAX_DESCENDANTS = 60;

/** Budget for remote ancestor fetching. Local lookups are not affected. */
export const REMOTE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Walk up the inReplyTo chain, oldest ancestor first.
 *
 * Local storage is consulted first; anything missing is fetched from its origin
 * server when a Fedify context is supplied. Without a context (or when a fetch
 * fails) the walk stops at what is stored — degraded, never thrown.
 *
 * @param {object} collections
 * @param {string} startUrl - inReplyTo of the post whose thread is wanted
 * @param {object} [options]
 * @param {object} [options.ctx] - Fedify context; omit for local-only
 * @param {object} [options.documentLoader]
 * @param {number} [options.maxDepth=MAX_ANCESTORS]
 * @returns {Promise<object[]>} ancestors, root first
 */
export async function getAncestors(collections, startUrl, options = {}) {
  const { ctx, documentLoader, maxDepth = MAX_ANCESTORS } = options;

  const ancestors = [];
  const seen = new Set();
  let currentUrl = startUrl;
  let depth = 0;

  while (currentUrl && depth < maxDepth) {
    depth += 1;

    // Cycle guard: a malicious or broken peer can point inReplyTo at an
    // ancestor and spin this loop until maxDepth. Cheap to prevent.
    if (seen.has(currentUrl)) break;
    seen.add(currentUrl);

    let parent = await collections.ap_timeline.findOne({
      $or: [{ uid: currentUrl }, { url: currentUrl }],
    });

    if (!parent && ctx) {
      parent = await fetchRemoteAncestor(currentUrl, ctx, documentLoader);
    }

    if (!parent) break;

    ancestors.unshift(parent);
    currentUrl = parent.inReplyTo;
  }

  return ancestors;
}

/**
 * Fetch a single ancestor from its origin server.
 *
 * @returns {Promise<object|null>} extracted item data, or null
 */
async function fetchRemoteAncestor(url, ctx, documentLoader) {
  const cached = getCached(url);
  let object = cached;

  if (!object) {
    try {
      object = await lookupWithSecurity(ctx, new URL(url), { documentLoader });
      if (object) setCache(url, object);
    } catch {
      return null;
    }
  }

  if (!object) return null;

  try {
    return await extractObjectData(object);
  } catch {
    return null;
  }
}

/**
 * Replies to a post, two levels deep, oldest first.
 *
 * @param {object} collections
 * @param {object} item - the post whose replies are wanted
 * @param {object} [options]
 * @param {number} [options.limit=MAX_DESCENDANTS]
 * @returns {Promise<object[]>}
 */
export async function getDescendants(collections, item, options = {}) {
  const limit = options.limit ?? MAX_DESCENDANTS;
  const targetUrls = [item?.uid, item?.url].filter(Boolean);

  if (targetUrls.length === 0) return [];

  const direct = await collections.ap_timeline
    .find({ inReplyTo: { $in: targetUrls } })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray();

  if (direct.length === 0) return [];

  const replyUrls = direct.flatMap((r) => [r.uid, r.url].filter(Boolean));

  const nested = await collections.ap_timeline
    .find({ inReplyTo: { $in: replyUrls } })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray();

  // Dedupe: a reply can match both queries if uid and url both resolve.
  const byUid = new Map();
  for (const reply of [...direct, ...nested]) {
    byUid.set(reply.uid || reply.url, reply);
  }

  return [...byUid.values()];
}

/**
 * Full thread context for a post.
 *
 * @param {object} collections
 * @param {object} item
 * @param {object} [options] - passed to getAncestors
 * @returns {Promise<{ancestors: object[], descendants: object[]}>}
 */
export async function getThread(collections, item, options = {}) {
  const [ancestors, descendants] = await Promise.all([
    item?.inReplyTo
      ? getAncestors(collections, item.inReplyTo, options)
      : Promise.resolve([]),
    getDescendants(collections, item, options),
  ]);

  return { ancestors, descendants };
}

/**
 * Restrict a thread to what an unauthenticated caller may see.
 *
 * @param {object[]} items
 * @returns {object[]}
 */
export function publicOnly(items) {
  return items.filter((item) => ["public", "unlisted"].includes(item.visibility));
}
