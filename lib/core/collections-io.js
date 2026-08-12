/**
 * Generic collection reads used by the reader's list views.
 *
 * These are the operations that were scattered as `collection.countDocuments()`
 * and `collection.find().sort()` across controllers taking a collection as a
 * parameter. That pattern is why the first version of the boundary check missed
 * them: it looked for `collections.ap_x.find(`, and a helper receiving the
 * collection as an argument never matches.
 *
 * Deliberately thin. There is no domain logic to extract here — the point is
 * that adapters stop holding a collection handle and calling methods on it, so
 * every database access has one place it can be found and changed.
 *
 * @module core/collections-io
 */

/**
 * Count documents matching a filter.
 *
 * @param {import("mongodb").Collection} collection
 * @param {object} [filter]
 * @returns {Promise<number>}
 */
export async function count(collection, filter = {}) {
  if (!collection) return 0;
  return collection.countDocuments(filter);
}

/**
 * List documents, sorted and paged.
 *
 * @param {import("mongodb").Collection} collection
 * @param {object} [options]
 * @param {object} [options.filter]
 * @param {object} [options.sort]
 * @param {object} [options.projection]
 * @param {number} [options.skip]
 * @param {number} [options.limit]
 * @returns {Promise<object[]>}
 */
export async function list(
  collection,
  { filter = {}, sort, projection, skip, limit } = {},
) {
  if (!collection) return [];

  let cursor = collection.find(filter);
  if (projection) cursor = cursor.project(projection);
  if (sort) cursor = cursor.sort(sort);
  if (skip) cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);

  return cursor.toArray();
}

/**
 * Find one document.
 *
 * @param {import("mongodb").Collection} collection
 * @param {object} filter
 * @returns {Promise<object|null>}
 */
export async function findOne(collection, filter) {
  if (!collection) return null;
  return collection.findOne(filter);
}

/**
 * Upsert a document.
 *
 * @param {import("mongodb").Collection} collection
 * @param {object} filter
 * @param {object} update - the $set payload
 * @param {object} [setOnInsert]
 * @returns {Promise<void>}
 */
export async function upsert(collection, filter, update, setOnInsert) {
  if (!collection) return;

  const operation = { $set: update };
  if (setOnInsert) operation.$setOnInsert = setOnInsert;

  await collection.updateOne(filter, operation, { upsert: true });
}

/**
 * Remove one document.
 *
 * @param {import("mongodb").Collection} collection
 * @param {object} filter
 * @returns {Promise<number>}
 */
export async function removeOne(collection, filter) {
  if (!collection) return 0;

  const { deletedCount } = await collection.deleteOne(filter);
  return deletedCount;
}
