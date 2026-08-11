/**
 * Opaque cursor encoding — core owns this end to end (DD-2, option a).
 *
 * Adapters receive an opaque string and pass it back unchanged. They never
 * construct or parse an ObjectId, which is what lets CI rule 5.2
 * ("lib/adapters/** may not import mongodb") stand.
 *
 * The encoding is deliberately reversible to an ObjectId hex string, because
 * the Mastodon wire format IS that hex string — clients already hold those ids
 * and paginate with them, so changing the format would break Phanpy, Elk,
 * Moshidon and Fedilab in the same release. Core emits the hex for that
 * adapter's dialect; the HTML adapter gets the same opaque token and never
 * looks inside it.
 *
 * @module core/cursor
 */
import { ObjectId } from "mongodb";

/**
 * Turn a stored document into an opaque cursor.
 *
 * @param {{_id: import("mongodb").ObjectId}} doc
 * @returns {string|null}
 */
export function encodeCursor(doc) {
  if (!doc?._id) return null;
  return doc._id.toString();
}

/**
 * Decode a cursor supplied by a client.
 *
 * Returns null for anything unusable rather than throwing — a malformed cursor
 * should degrade to "first page", not a 500. Note that a sha256 prefix is a
 * syntactically valid ObjectId, so this cannot detect a cursor minted from a
 * boost wrapper's surface id (see F-1); it only guarantees the shape.
 *
 * @param {string} cursor
 * @returns {import("mongodb").ObjectId|null}
 */
export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;

  try {
    return new ObjectId(cursor);
  } catch {
    return null;
  }
}

/**
 * Build the Mongo filter and sort for a cursored page.
 *
 * Ordering is by `receivedAt` (DD-1: ingest order) with `_id` as the tiebreak,
 * so items ingested in the same millisecond stay stably ordered and cursors
 * remain unambiguous.
 *
 * @param {object} baseFilter - Filter to extend
 * @param {object} [page]
 * @param {string} [page.before] - Items strictly older than this cursor
 * @param {string} [page.after] - Items strictly newer, newest-first
 * @param {string} [page.since] - Items strictly newer, oldest-first (reversed)
 * @returns {{filter: object, sort: object, reverse: boolean}}
 */
export function buildPage(baseFilter, { before, after, since } = {}) {
  const filter = { ...baseFilter };
  let sort = { receivedAt: -1, _id: -1 };
  let reverse = false;

  const beforeId = decodeCursor(before);
  if (beforeId) {
    filter._id = { ...filter._id, $lt: beforeId };
  }

  const afterId = decodeCursor(after);
  if (afterId) {
    filter._id = { ...filter._id, $gt: afterId };
  }

  const sinceId = decodeCursor(since);
  if (sinceId) {
    filter._id = { ...filter._id, $gt: sinceId };
    sort = { receivedAt: 1, _id: 1 };
    reverse = true;
  }

  return { filter, sort, reverse };
}
