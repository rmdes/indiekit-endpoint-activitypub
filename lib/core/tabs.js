/**
 * Explore-tab domain logic.
 *
 * Custom tabs are a reader-only feature — the Mastodon API has no vocabulary
 * for them. They live in core anyway, because "reader-only" is a statement
 * about which adapters exist today, not about where the logic belongs. When a
 * C2S adapter can express them, it calls the same functions.
 *
 * @module core/tabs
 */
import { decodeCursor } from "./cursor.js";

/**
 * All tabs, in display order.
 *
 * @param {object} collections
 * @param {object} [options]
 * @param {object} [options.projection]
 * @returns {Promise<object[]>}
 */
export async function getTabs(collections, { projection } = {}) {
  if (!collections.ap_explore_tabs) return [];

  let cursor = collections.ap_explore_tabs.find({});
  if (projection) cursor = cursor.project(projection);

  return cursor.sort({ order: 1 }).toArray();
}

/**
 * Insert a tab at the end of the order.
 *
 * The caller supplies a fully-formed tab. All four indexed fields — type,
 * domain, scope, hashtag — must be present with explicit nulls where not
 * applicable, because the unique index covers all of them.
 *
 * A duplicate key (11000) comes back as `{ duplicate: true }` rather than
 * throwing: "that tab already exists" is a 409, not a 500.
 *
 * @param {object} collections
 * @param {object} tab
 * @returns {Promise<{tab: object|null, duplicate: boolean}>}
 */
export async function insertTab(collections, tab) {
  if (!collections.ap_explore_tabs) return { tab: null, duplicate: false };

  const last = await collections.ap_explore_tabs
    .find({})
    .sort({ order: -1 })
    .limit(1)
    .toArray();

  const doc = {
    ...tab,
    order: last.length > 0 ? last[0].order + 1 : 0,
    addedAt: new Date().toISOString(),
  };

  try {
    const { insertedId } = await collections.ap_explore_tabs.insertOne(doc);
    return { tab: { ...doc, _id: insertedId }, duplicate: false };
  } catch (error) {
    if (error.code === 11_000) return { tab: null, duplicate: true };
    throw error;
  }
}

/**
 * Delete a tab by its natural key, then re-compact the order numbers.
 *
 * Compaction matters: without it, repeated add/remove leaves gaps and each
 * new tab's `order` climbs without bound.
 *
 * @param {object} collections
 * @param {object} filter - the tab's natural key
 * @returns {Promise<number>} tabs deleted
 */
export async function deleteTab(collections, filter) {
  if (!collections.ap_explore_tabs) return 0;

  const { deletedCount } = await collections.ap_explore_tabs.deleteOne(filter);

  const remaining = await collections.ap_explore_tabs
    .find({})
    .sort({ order: 1 })
    .toArray();

  if (remaining.length > 0) {
    await collections.ap_explore_tabs.bulkWrite(
      remaining.map((tab, index) => ({
        updateOne: { filter: { _id: tab._id }, update: { $set: { order: index } } },
      })),
      { ordered: false },
    );
  }

  return deletedCount;
}

/**
 * Reorder tabs to match the supplied id sequence.
 *
 * Ids are opaque STRINGS as received from a client; core decodes them, so no
 * adapter needs mongodb (boundary rule 5.2). Anything that does not decode is
 * dropped rather than throwing — a stale id from a client should not 500.
 *
 * @param {object} collections
 * @param {string[]} ids - desired order
 * @returns {Promise<number>} tabs whose order changed
 */
export async function reorderTabs(collections, ids) {
  if (!collections.ap_explore_tabs || !Array.isArray(ids)) return 0;

  const ops = [];

  ids.forEach((id, index) => {
    const objectId = decodeCursor(id);
    if (!objectId) return;

    ops.push({
      updateOne: {
        filter: { _id: objectId },
        update: { $set: { order: index } },
      },
    });
  });

  if (ops.length === 0) return 0;

  const { modifiedCount } = await collections.ap_explore_tabs.bulkWrite(ops, {
    ordered: false,
  });

  return modifiedCount;
}
