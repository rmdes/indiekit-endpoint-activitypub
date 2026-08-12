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
 * @returns {Promise<object[]>}
 */
export async function getTabs(collections) {
  if (!collections.ap_explore_tabs) return [];
  return collections.ap_explore_tabs.find({}).sort({ order: 1 }).toArray();
}

/**
 * Add a tab, appended to the end.
 *
 * @param {object} collections
 * @param {object} tab - { type, label, value }
 * @returns {Promise<object|null>}
 */
export async function addTab(collections, tab) {
  if (!collections.ap_explore_tabs) return null;

  const count = await collections.ap_explore_tabs.countDocuments();

  const { insertedId } = await collections.ap_explore_tabs.insertOne({
    ...tab,
    order: count,
    createdAt: new Date().toISOString(),
  });

  return collections.ap_explore_tabs.findOne({ _id: insertedId });
}

/**
 * Remove a tab by its opaque id.
 *
 * @param {object} collections
 * @param {string} id
 * @returns {Promise<number>}
 */
export async function removeTab(collections, id) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_explore_tabs) return 0;

  const { deletedCount } = await collections.ap_explore_tabs.deleteOne({
    _id: objectId,
  });

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
