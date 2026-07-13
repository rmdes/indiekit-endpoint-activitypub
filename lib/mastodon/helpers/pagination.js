/**
 * Mastodon-compatible pagination helpers using MongoDB ObjectId.
 *
 * ObjectIds are 12-byte values with a 4-byte timestamp prefix, making
 * them chronologically sortable. Status IDs are _id.toString() — unique,
 * sortable, and directly usable as pagination cursors.
 *
 * Emits RFC 8288 Link headers that Phanpy/Elk/Moshidon parse.
 */
import { ObjectId } from "mongodb";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

/**
 * Parse and clamp the limit parameter.
 *
 * @param {string|number} raw - Raw limit value from query string
 * @returns {number}
 */
export function parseLimit(raw) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Try to parse a cursor string as an ObjectId.
 * Returns null if invalid.
 *
 * @param {string} cursor - ObjectId hex string from client
 * @returns {ObjectId|null}
 */
function parseCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    return new ObjectId(cursor);
  } catch {
    return null;
  }
}

/**
 * Build a MongoDB filter object for ObjectId-based pagination.
 *
 * Mastodon cursor params (all optional, applied to `_id`):
 *   max_id   — return items older than this ID (exclusive)
 *   min_id   — return items newer than this ID (exclusive), closest first
 *   since_id — return items newer than this ID (exclusive), most recent first
 *
 * @param {object} baseFilter - Existing MongoDB filter to extend
 * @param {object} cursors
 * @param {string} [cursors.max_id] - ObjectId hex string
 * @param {string} [cursors.min_id] - ObjectId hex string
 * @param {string} [cursors.since_id] - ObjectId hex string
 * @returns {{ filter: object, sort: object, reverse: boolean }}
 */
export function buildPaginationQuery(baseFilter, { max_id, min_id, since_id } = {}) {
  const filter = { ...baseFilter };
  let sort = { _id: -1 }; // newest first (default)
  let reverse = false;

  if (max_id) {
    const oid = parseCursor(max_id);
    if (oid) {
      filter._id = { ...filter._id, $lt: oid };
    }
  }

  if (since_id) {
    const oid = parseCursor(since_id);
    if (oid) {
      filter._id = { ...filter._id, $gt: oid };
    }
  }

  if (min_id) {
    const oid = parseCursor(min_id);
    if (oid) {
      filter._id = { ...filter._id, $gt: oid };
      sort = { _id: 1 };
      reverse = true;
    }
  }

  return { filter, sort, reverse };
}

/**
 * Set the Link pagination header on an Express response.
 *
 * @param {object} res - Express response object
 * @param {object} req - Express request object (for building URLs)
 * @param {Array} items - Result items (must have `_id`)
 * @param {number} limit - The limit used for the query
 */
export function setPaginationHeaders(res, req, items, limit) {
  if (!items?.length) return;

  // Emit Link whenever we returned items (Mastodon-style): the client follows
  // `next` until it gets an empty page. The old `items.length < limit` guard
  // killed pagination the moment moderation filtering dropped even one item
  // from a page (e.g. 17 of 20 kept → no Link → client stops early). `limit` is
  // kept in the signature for callers/compat.
  void limit;

  const firstId = items[0]._id.toString();
  const lastId = items[items.length - 1]._id.toString();

  const baseUrl = `${req.protocol}://${req.get("host")}${req.path}`;

  // Preserve existing query params (like types[] for notifications)
  const existingParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "max_id" || key === "min_id" || key === "since_id") continue;
    if (Array.isArray(value)) {
      for (const v of value) existingParams.append(key, v);
    } else {
      existingParams.set(key, String(value));
    }
  }

  const links = [];

  // rel="next" — older items (max_id = last item's ID)
  const nextParams = new URLSearchParams(existingParams);
  nextParams.set("max_id", lastId);
  links.push(`<${baseUrl}?${nextParams.toString()}>; rel="next"`);

  // rel="prev" — newer items (min_id = first item's ID)
  const prevParams = new URLSearchParams(existingParams);
  prevParams.set("min_id", firstId);
  links.push(`<${baseUrl}?${prevParams.toString()}>; rel="prev"`);

  res.set("Link", links.join(", "));
}
