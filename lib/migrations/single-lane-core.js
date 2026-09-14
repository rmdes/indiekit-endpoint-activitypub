/**
 * Stage 2 migrations for the single-lane core.
 *
 * Run in this order — Amendment A/A3 corrected it, and the order is the whole
 * point:
 *
 *   1. ensureReceivedAtIndexes()   create the index while the field is empty
 *   2. backfillReceivedAt()        M-2 — populate it
 *   3. verifyTimelineIndexUsage()  M-3 gate — explain() the REAL query, at
 *                                  real volume, and confirm IXSCAN
 *   4. (only then) the core starts sorting on it
 *
 * Verifying before the backfill would explain() an index over zero documents
 * and prove nothing. Switching the sort before verifying risks a COLLSCAN on
 * the production timeline — the one step in this plan that can cause a visible
 * outage.
 *
 * M-1a (readAt) is ADDITIVE and dual-writes: `read` and `dismissed` are
 * retained and kept current for one release, so a rollback inside that window
 * is a pure code revert with no data restore. M-1b drops them later.
 *
 * @module migrations/single-lane-core
 */

/**
 * Create the indexes the ingest-ordered timeline needs. Idempotent.
 *
 * @param {object} collections
 * @returns {Promise<void>}
 */
export async function ensureReceivedAtIndexes(collections) {
  const { ap_timeline, ap_notifications } = collections;

  // Primary feed sort. `_id` is the tiebreak so same-millisecond arrivals stay
  // stably ordered and cursors are unambiguous.
  await ap_timeline.createIndex(
    { receivedAt: -1, _id: -1 },
    { background: true, name: "timeline_feed_order" },
  );

  // Unread counts scan on readAt within the feed order.
  await ap_timeline.createIndex(
    { readAt: 1, receivedAt: -1 },
    { background: true, name: "timeline_unread" },
  );

  await ap_notifications.createIndex(
    { readAt: 1, published: -1 },
    { background: true, name: "notifications_unread" },
  );
}

/**
 * M-2 — backfill `receivedAt` on ap_timeline.
 *
 * Source of truth is the ObjectId timestamp: that is literally when the row was
 * written, which is what ingest order means. Items are processed in batches so
 * a large collection does not build one enormous bulk op.
 *
 * `isContext` ancestors are special-cased (DD-1 acceptance criterion on task
 * 2.4): they were fetched to reconstruct a thread, not delivered to us, so they
 * inherit the `receivedAt` of the item that caused the fetch. Without this they
 * would surface at the top of the timeline out of context — which is exactly
 * the artefact Mastodon has carried unresolved since #33747, and which a
 * separate field lets us avoid.
 *
 * Idempotent: only touches documents with no `receivedAt`.
 *
 * @param {object} collections
 * @param {object} [options]
 * @param {number} [options.batchSize=500]
 * @returns {Promise<{scanned: number, updated: number, contextInherited: number}>}
 */
export async function backfillReceivedAt(collections, { batchSize = 500 } = {}) {
  const { ap_timeline } = collections;

  let scanned = 0;
  let updated = 0;
  let contextInherited = 0;

  while (true) {
    const batch = await ap_timeline
      .find({ receivedAt: { $exists: false } })
      .limit(batchSize)
      .toArray();

    if (batch.length === 0) break;

    const ops = [];

    for (const doc of batch) {
      scanned += 1;

      let receivedAt = doc._id.getTimestamp().toISOString();

      if (doc.isContext) {
        // Inherit from the descendant that pulled this ancestor in. Fall back
        // to our own insertion time if the chain is broken.
        const child = await ap_timeline.findOne(
          { inReplyTo: doc.uid, isContext: { $ne: true } },
          { projection: { _id: 1, receivedAt: 1 } },
        );

        if (child) {
          receivedAt =
            child.receivedAt || child._id.getTimestamp().toISOString();
          contextInherited += 1;
        }
      }

      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { receivedAt } },
        },
      });
    }

    if (ops.length > 0) {
      const result = await ap_timeline.bulkWrite(ops, { ordered: false });
      updated += result.modifiedCount;
    }
  }

  return { scanned, updated, contextInherited };
}

/**
 * M-3 gate — confirm the real feed query uses an index at real volume.
 *
 * Call AFTER backfillReceivedAt. Returns the winning plan so a caller can log
 * it; throws if the plan is a collection scan, because switching the sort in
 * that state is the outage this ordering exists to prevent.
 *
 * @param {object} collections
 * @returns {Promise<{stage: string, indexName: string|undefined, docsExamined: number}>}
 */
export async function verifyTimelineIndexUsage(collections) {
  const { ap_timeline } = collections;

  const explain = await ap_timeline
    .find({ isContext: { $ne: true }, visibility: { $nin: ["direct"] } })
    .sort({ receivedAt: -1, _id: -1 })
    .limit(20)
    .explain("executionStats");

  const winning = explain?.queryPlanner?.winningPlan ?? {};
  const stages = JSON.stringify(winning);
  const docsExamined = explain?.executionStats?.totalDocsExamined ?? -1;

  if (!stages.includes("IXSCAN")) {
    throw new Error(
      "Timeline feed query is not using an index (no IXSCAN in the winning " +
        "plan). Do NOT switch the sort — run ensureReceivedAtIndexes() and " +
        "backfillReceivedAt() first. " +
        `Winning plan: ${stages.slice(0, 400)}`,
    );
  }

  const indexName = stages.match(/"indexName"\s*:\s*"([^"]+)"/)?.[1];

  return { stage: "IXSCAN", indexName, docsExamined };
}

/**
 * M-1a — unify read state onto a nullable `readAt` timestamp (DD-3).
 *
 * ADDITIVE ONLY. `read` and `dismissed` are left in place and kept current by
 * the core's write paths for one release, so reverting the registry pin needs
 * no data restore. M-1b drops them.
 *
 * Mapping:
 *   ap_timeline       read: true                     -> readAt = _id timestamp
 *   ap_notifications  read: true OR dismissed: true  -> readAt = published || _id timestamp
 *
 * A timestamp rather than a boolean because FEP-34ec dismissal wants ordering,
 * and because it makes the mapping lossless.
 *
 * Idempotent: only touches documents with no `readAt`.
 *
 * @param {object} collections
 * @returns {Promise<{timeline: number, notifications: number}>}
 */
export async function backfillReadAt(collections) {
  const { ap_timeline, ap_notifications } = collections;

  const timelineDocs = await ap_timeline
    .find({ readAt: { $exists: false } }, { projection: { _id: 1, read: 1 } })
    .toArray();

  const timelineOps = timelineDocs.map((doc) => ({
    updateOne: {
      filter: { _id: doc._id },
      update: {
        $set: {
          readAt: doc.read === true ? doc._id.getTimestamp().toISOString() : null,
        },
      },
    },
  }));

  const notifDocs = await ap_notifications
    .find(
      { readAt: { $exists: false } },
      { projection: { _id: 1, read: 1, dismissed: 1, published: 1 } },
    )
    .toArray();

  const notifOps = notifDocs.map((doc) => {
    // Either lane having marked it counts — that IS the unification.
    const wasRead = doc.read === true || doc.dismissed === true;

    return {
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            readAt: wasRead
              ? doc.published || doc._id.getTimestamp().toISOString()
              : null,
          },
        },
      },
    };
  });

  const timeline = timelineOps.length
    ? (await ap_timeline.bulkWrite(timelineOps, { ordered: false })).modifiedCount
    : 0;

  const notifications = notifOps.length
    ? (await ap_notifications.bulkWrite(notifOps, { ordered: false })).modifiedCount
    : 0;

  return { timeline, notifications };
}

/**
 * Run the Stage 2 migrations in the only safe order.
 *
 * @param {object} collections
 * @returns {Promise<object>} per-step results, for logging
 */
export async function runSingleLaneMigrations(collections) {
  await ensureReceivedAtIndexes(collections);

  const received = await backfillReceivedAt(collections);
  const read = await backfillReadAt(collections);
  const tags = await backfillTagFollowedAt(collections);
  const notificationContext = await backfillNotificationContext(collections);
  const index = await verifyTimelineIndexUsage(collections);

  return { received, read, tags, notificationContext, index };
}

/**
 * Repair followed-tag rows written by the old core/tags.js copy.
 *
 * It recorded a local follow as `createdAt`; the shared model reads
 * `followedAt`, so those follows looked absent in the reader. `createdAt` was
 * only ever written by a local follow, so promoting it is lossless. Rows
 * without it (global-only follows) are untouched. Idempotent.
 *
 * @param {object} collections
 * @returns {Promise<number>} rows repaired
 */
export async function backfillTagFollowedAt(collections) {
  if (!collections.ap_followed_tags) return 0;

  const result = await collections.ap_followed_tags.updateMany(
    { followedAt: { $exists: false }, createdAt: { $exists: true } },
    [{ $set: { followedAt: "$createdAt" } }],
  );
  return result.modifiedCount;
}

/**
 * Give reply/mention notifications a thread row (beta.6).
 *
 * Before beta.6 a reply or mention from an account we don't follow existed only
 * as a notification, so no thread could show it and the Mastodon notification
 * pointed at a status id no route could resolve. Ingest now stores such posts
 * as isContext rows (inbox-handlers.js#handleCreate); this builds the same row
 * for notifications received earlier, from the notification's own fields.
 *
 * Visibility is unknown here, so rows are PRIVATE — visible to the owner,
 * never to anonymous thread readers. Existing rows (matched by uid or url) are
 * never touched. Idempotent; three queries regardless of volume.
 *
 * @param {object} collections
 * @returns {Promise<number>} rows created
 */
export async function backfillNotificationContext(collections) {
  const { ap_notifications, ap_timeline } = collections;
  if (!ap_notifications || !ap_timeline) return 0;

  const notifications = await ap_notifications
    .find({ type: { $in: ["reply", "mention"] } })
    .toArray();

  const isUri = (value) => typeof value === "string" && /^https?:\/\//.test(value);
  const candidates = notifications
    .map((n) => ({ n, uid: isUri(n.uid) ? n.uid : n.url }))
    .filter(({ uid }) => isUri(uid));
  if (candidates.length === 0) return 0;

  const keys = [...new Set(candidates.flatMap(({ n, uid }) => [uid, n.url].filter(Boolean)))];
  const existing = await ap_timeline
    .find({ $or: [{ uid: { $in: keys } }, { url: { $in: keys } }] }, { projection: { uid: 1, url: 1 } })
    .toArray();
  const known = new Set(existing.flatMap((row) => [row.uid, row.url].filter(Boolean)));

  const ops = candidates
    .filter(({ n, uid }) => !known.has(uid) && !(n.url && known.has(n.url)))
    .map(({ n, uid }) => {
      const at = n.createdAt || n.published || new Date().toISOString();
      return {
        updateOne: {
          filter: { uid },
          update: {
            $setOnInsert: {
              uid,
              url: n.url || uid,
              type: "note",
              content: n.content || { text: "", html: "" },
              author: {
                name: n.actorName || "",
                url: n.actorUrl || "",
                photo: n.actorPhoto || "",
                handle: n.actorHandle || "",
              },
              published: n.published || at,
              createdAt: at,
              receivedAt: at,
              readAt: null,
              read: false,
              readBy: [],
              visibility: "private",
              isContext: true,
              sensitive: false,
              summary: "",
              category: [],
              photo: [],
              video: [],
              audio: [],
              ...(n.type === "reply" && n.targetUrl ? { inReplyTo: n.targetUrl } : {}),
            },
          },
          upsert: true,
        },
      };
    });

  if (ops.length === 0) return 0;
  const result = await ap_timeline.bulkWrite(ops, { ordered: false });
  return result.upsertedCount;
}
