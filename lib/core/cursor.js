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
 * Keyset condition for "strictly past this anchor" on `(field, _id)`.
 *
 * `op` is `$lt` (older, in a newest-first feed) or `$gt` (newer). Documents
 * with no value for `field` sort last in a descending sort, so a null anchor
 * only has other nulls behind it, and everything with a value ahead of it.
 *
 * @param {string} field
 * @param {"$lt"|"$gt"} op
 * @param {{_id: import("mongodb").ObjectId}} anchor
 * @returns {object}
 */
function pastAnchor(field, op, anchor) {
  const value = anchor[field];
  const tiebreak = { [field]: value ?? null, _id: { [op]: anchor._id } };

  if (value == null) {
    return op === "$lt" ? tiebreak : { $or: [{ [field]: { $ne: null } }, tiebreak] };
  }

  return { $or: [{ [field]: { [op]: value } }, tiebreak] };
}

/**
 * Build the Mongo filter and sort for a cursored page.
 *
 * Pages follow the SORT key, with `_id` as the tiebreak. Cursors are `_id` hex
 * (the Mastodon wire format, DD-2), so the cursor document is looked up to
 * learn where it sits in sort order. Paging on `_id` alone skipped and repeated
 * items wherever the two orders disagree — `isContext` ancestors inheriting a
 * descendant's `receivedAt` (DD-1) is the everyday case.
 *
 * @param {import("mongodb").Collection} collection - collection being paged
 * @param {object} baseFilter - Filter to extend
 * @param {object} [page]
 * @param {string} [page.before] - Items strictly older than this cursor
 * @param {string} [page.after] - Items strictly newer, newest-first
 * @param {string} [page.since] - Items strictly newer, oldest-first (reversed)
 * @param {string} [sortField="receivedAt"] - primary sort key; "_id" for none
 * @returns {Promise<{filter: object, sort: object, reverse: boolean, cursored: boolean}>}
 */
export async function buildPage(
  collection,
  baseFilter,
  { before, after, since } = {},
  sortField = "receivedAt",
) {
  const primary = sortField === "_id" ? {} : { [sortField]: -1 };
  let sort = { ...primary, _id: -1 };
  let reverse = false;
  const clauses = [];

  const bounds = [
    [decodeCursor(before), "$lt"],
    [decodeCursor(after), "$gt"],
    [decodeCursor(since), "$gt"],
  ];

  for (const [id, op] of bounds) {
    if (!id) continue;

    if (sortField === "_id") {
      clauses.push({ _id: { [op]: id } });
      continue;
    }

    const anchor = await collection.findOne(
      { _id: id },
      { projection: { [sortField]: 1 } },
    );
    // ponytail: a cursor whose document was deleted falls back to `_id`
    // order — approximate for that one page; exact would need the sort value
    // inside the cursor, which the Mastodon wire format cannot carry.
    clauses.push(anchor ? pastAnchor(sortField, op, anchor) : { _id: { [op]: id } });
  }

  if (decodeCursor(since)) {
    sort = Object.fromEntries(Object.keys(sort).map((key) => [key, 1]));
    reverse = true;
  }

  const filter =
    clauses.length === 0
      ? { ...baseFilter }
      : { $and: [baseFilter, ...clauses] };

  return { filter, sort, reverse, cursored: clauses.length > 0 };
}
