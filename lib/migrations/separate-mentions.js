/**
 * Migration: separate-mentions
 *
 * Moves @-prefixed entries from category[] to a new mentions[] array in all
 * ap_timeline documents. Tracked in ap_kv for idempotency.
 *
 * Before: category: ["@user@instance", "hashtag", "@another@host"]
 * After:  category: ["hashtag"]
 *         mentions: [{ name: "user@instance", url: "" }, { name: "another@host", url: "" }]
 *
 * Note: URLs are empty for legacy items since we can't reconstruct them.
 * New items will have URLs populated by the fixed extractObjectData() (Task 1).
 */

const MIGRATION_KEY = "migration:separate-mentions";

/**
 * Run the separate-mentions migration (idempotent)
 * @param {object} collections - MongoDB collections
 * @returns {Promise<{ skipped: boolean, updated: number }>}
 */
export async function runSeparateMentionsMigration(collections) {
  const { ap_kv, ap_timeline } = collections;

  // Check if already completed
  const state = await ap_kv.findOne({ _id: MIGRATION_KEY });
  if (state?.value?.completed) {
    return { skipped: true, updated: 0 };
  }

  // Find all documents where category[] contains @-prefixed entries
  const docs = await ap_timeline
    .find({ category: { $regex: /^@/ } })
    .toArray();

  if (docs.length === 0) {
    // No docs to migrate — mark complete immediately
    await ap_kv.updateOne(
      { _id: MIGRATION_KEY },
      { $set: { value: { completed: true, date: new Date().toISOString(), updated: 0 } } },
      { upsert: true }
    );
    return { skipped: false, updated: 0 };
  }

  // Build bulk operations
  const ops = docs.map((doc) => {
    const mentions = (doc.mentions || []).slice(); // preserve any existing mentions
    const newCategory = [];

    for (const entry of doc.category || []) {
      if (typeof entry === "string" && entry.startsWith("@")) {
        // Move to mentions[] — strip leading @ to match timeline-store convention
        const strippedName = entry.slice(1);
        const alreadyPresent = mentions.some((m) => m.name === strippedName);
        if (!alreadyPresent) {
          mentions.push({ name: strippedName, url: "" });
        }
      } else {
        newCategory.push(entry);
      }
    }

    return {
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            category: newCategory,
            mentions
          }
        }
      }
    };
  });

  const result = await ap_timeline.bulkWrite(ops, { ordered: false });
  const updated = result.modifiedCount || 0;

  // Mark migration complete
  await ap_kv.updateOne(
    { _id: MIGRATION_KEY },
    { $set: { value: { completed: true, date: new Date().toISOString(), updated } } },
    { upsert: true }
  );

  return { skipped: false, updated };
}
