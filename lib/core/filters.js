/**
 * Keyword-filter domain logic.
 *
 * A filter is one document in `ap_filters` plus N keyword documents in
 * `ap_filter_keywords`. Splitting them lets a keyword be edited without
 * rewriting the filter, which is how the Mastodon v2 filter API models it.
 *
 * Filters are currently Mastodon-only — the reader has no filter UI. They live
 * in core so that when it grows one, or a C2S adapter needs them, there is
 * nothing to port.
 *
 * @module core/filters
 */
import { decodeCursor } from "./cursor.js";

/**
 * NOTE ON `filterId`: keyword documents store it as an ObjectId, not a string.
 * That is the shape already in production and in mastodon/helpers/apply-filters.js
 * — writing strings here would silently orphan every existing filter's keywords
 * (the filter would list, the keywords would not, and nothing would error).
 * Core decodes opaque ids at its edge and works in ObjectIds internally.
 */

/**
 * All filters, each with its keywords attached.
 *
 * One query per collection rather than one per filter — the N+1 shape is easy
 * to reach for here and pointless at any size.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getFilters(collections) {
  if (!collections.ap_filters) return [];

  const filters = await collections.ap_filters.find({}).toArray();
  if (filters.length === 0) return [];

  const keywords = collections.ap_filter_keywords
    ? await collections.ap_filter_keywords
        .find({ filterId: { $in: filters.map((f) => f._id) } })
        .toArray()
    : [];

  const byFilter = new Map();
  for (const keyword of keywords) {
    const key = String(keyword.filterId);
    if (!byFilter.has(key)) byFilter.set(key, []);
    byFilter.get(key).push(keyword);
  }

  return filters.map((filter) => ({
    ...filter,
    keywords: byFilter.get(String(filter._id)) || [],
  }));
}

/**
 * One filter by its opaque id, with keywords.
 *
 * @param {object} collections
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getFilter(collections, id) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_filters) return null;

  const filter = await collections.ap_filters.findOne({ _id: objectId });
  if (!filter) return null;

  const keywords = collections.ap_filter_keywords
    ? await collections.ap_filter_keywords.find({ filterId: filter._id }).toArray()
    : [];

  return { ...filter, keywords };
}

/**
 * Create a filter and its keywords.
 *
 * @param {object} collections
 * @param {object} filter - { title, context, filterAction, expiresAt }
 * @param {Array<{keyword: string, wholeWord: boolean}>} [keywords]
 * @returns {Promise<object|null>} the created filter, with keywords
 */
export async function createFilter(collections, filter, keywords = []) {
  if (!collections.ap_filters) return null;

  const { insertedId } = await collections.ap_filters.insertOne({
    ...filter,
    createdAt: new Date().toISOString(),
  });

  if (keywords.length > 0 && collections.ap_filter_keywords) {
    await collections.ap_filter_keywords.insertMany(
      keywords.map((k) => ({
        filterId: insertedId,
        keyword: k.keyword,
        wholeWord: k.wholeWord ?? false,
        createdAt: new Date().toISOString(),
      })),
    );
  }

  return getFilter(collections, insertedId.toString());
}

/**
 * Update a filter's own fields. Keywords are managed separately.
 *
 * @param {object} collections
 * @param {string} id
 * @param {object} updates
 * @returns {Promise<object|null>} the updated filter
 */
export async function updateFilter(collections, id, updates) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_filters) return null;

  await collections.ap_filters.updateOne({ _id: objectId }, { $set: updates });

  return getFilter(collections, id);
}

/**
 * Delete a filter and every keyword belonging to it.
 *
 * @param {object} collections
 * @param {string} id
 * @returns {Promise<number>} filters deleted (0 or 1)
 */
export async function deleteFilter(collections, id) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_filters) return 0;

  if (collections.ap_filter_keywords) {
    // Orphaned keywords would silently keep filtering, so they go first.
    await collections.ap_filter_keywords.deleteMany({ filterId: objectId });
  }

  const { deletedCount } = await collections.ap_filters.deleteOne({
    _id: objectId,
  });

  return deletedCount;
}

/**
 * Replace a filter's keywords wholesale.
 *
 * @param {object} collections
 * @param {string} id
 * @param {Array<{keyword: string, wholeWord: boolean}>} keywords
 * @returns {Promise<void>}
 */
export async function replaceKeywords(collections, id, keywords) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_filter_keywords) return;

  await collections.ap_filter_keywords.deleteMany({ filterId: objectId });

  if (keywords.length > 0) {
    await collections.ap_filter_keywords.insertMany(
      keywords.map((k) => ({
        filterId: objectId,
        keyword: k.keyword,
        wholeWord: k.wholeWord ?? false,
        createdAt: new Date().toISOString(),
      })),
    );
  }
}
