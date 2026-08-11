/**
 * Stage 2 — core/timeline.js and the Stage 2 migrations.
 *
 * Covers the ratified decisions directly, so a later edit that quietly reverts
 * one fails here rather than in production:
 *   DD-1  ingest ordering on receivedAt, with isContext inheriting its parent's
 *   DD-2  opaque cursors
 *   DD-3  shared readAt
 *   DD-4  followers-only included on home, excluded from public/tag
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { seed } from "./helpers/fixtures.js";

import {
  buildTimelineFilter,
  clampLimit,
  countNewer,
  countUnread,
  getItem,
  getTimeline,
  markRead,
} from "../lib/core/timeline.js";
import {
  backfillReadAt,
  backfillReceivedAt,
  ensureReceivedAtIndexes,
  verifyTimelineIndexUsage,
} from "../lib/migrations/single-lane-core.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.reset();
  await seed(mongo.collections);
});

describe("Stage 2 migrations — order is load-bearing", () => {
  it("backfills receivedAt from the ObjectId timestamp", async () => {
    const result = await backfillReceivedAt(mongo.collections);

    assert.ok(result.updated > 0);
    assert.equal(
      await mongo.collections.ap_timeline.countDocuments({
        receivedAt: { $exists: false },
      }),
      0,
      "every row must end up with receivedAt",
    );
  });

  it("is idempotent — a second run touches nothing", async () => {
    await backfillReceivedAt(mongo.collections);
    const second = await backfillReceivedAt(mongo.collections);

    assert.equal(second.scanned, 0);
    assert.equal(second.updated, 0);
  });

  it("context ancestors inherit their descendant's receivedAt (DD-1)", async () => {
    // notes/16 is isContext. Give it a descendant so inheritance has a source.
    await mongo.collections.ap_timeline.updateOne(
      { uid: "https://remote.example/notes/10" },
      { $set: { inReplyTo: "https://remote.example/notes/16" } },
    );

    const result = await backfillReceivedAt(mongo.collections);
    assert.ok(result.contextInherited > 0, "at least one ancestor must inherit");

    const ancestor = await mongo.collections.ap_timeline.findOne({
      uid: "https://remote.example/notes/16",
    });
    const child = await mongo.collections.ap_timeline.findOne({
      uid: "https://remote.example/notes/10",
    });

    assert.equal(
      ancestor.receivedAt,
      child._id.getTimestamp().toISOString(),
      "a backfilled ancestor must not surface at the top of the timeline",
    );
  });

  it("verifyTimelineIndexUsage THROWS before the index exists", async () => {
    await mongo.collections.ap_timeline.dropIndexes();
    await backfillReceivedAt(mongo.collections);

    await assert.rejects(
      () => verifyTimelineIndexUsage(mongo.collections),
      /not using an index/,
      "the M-3 gate must refuse to pass a collection scan",
    );
  });

  it("verifyTimelineIndexUsage passes once index and data exist", async () => {
    await ensureReceivedAtIndexes(mongo.collections);
    await backfillReceivedAt(mongo.collections);

    const result = await verifyTimelineIndexUsage(mongo.collections);
    assert.equal(result.stage, "IXSCAN");
  });

  it("M-1a maps read/dismissed onto readAt and RETAINS both (rollback window)", async () => {
    await backfillReadAt(mongo.collections);

    const readOne = await mongo.collections.ap_timeline.findOne({ read: true });
    assert.ok(readOne.readAt, "a read item gets a readAt timestamp");
    assert.equal(readOne.read, true, "legacy field retained for M-1b");

    const dismissed = await mongo.collections.ap_notifications.findOne({
      dismissed: true,
    });
    assert.ok(
      dismissed.readAt,
      "a Mastodon-dismissed notification counts as read (DD-3)",
    );

    const readInReader = await mongo.collections.ap_notifications.findOne({
      uid: "https://remote.example/likes/2",
    });
    assert.ok(
      readInReader.readAt,
      "a reader-read notification counts as read too — the unification",
    );
  });
});

describe("core/timeline — filters", () => {
  it("home includes followers-only, excludes direct (DD-4)", () => {
    const filter = buildTimelineFilter({ feed: "home" });
    assert.deepEqual(filter.visibility, { $nin: ["direct"] });
  });

  it("public and tag feeds stay narrower — they must NOT be flattened", () => {
    assert.equal(buildTimelineFilter({ feed: "public" }).visibility, "public");
    assert.deepEqual(buildTimelineFilter({ feed: "tag" }).visibility, {
      $in: ["public", "unlisted"],
    });
  });

  it("excludes context ancestors unless asked", () => {
    assert.deepEqual(buildTimelineFilter({}).isContext, { $ne: true });
    assert.equal(buildTimelineFilter({ includeContext: true }).isContext, undefined);
  });

  it("excludeReplies covers null, missing AND empty string", () => {
    assert.deepEqual(buildTimelineFilter({ excludeReplies: true }).inReplyTo, {
      $in: [null, ""],
    });
  });

  it("rejects non-string tag and authorUrl (operator injection)", () => {
    assert.throws(() => buildTimelineFilter({ tag: { $ne: null } }), TypeError);
    assert.throws(() => buildTimelineFilter({ authorUrl: { $ne: null } }), TypeError);
  });

  it("escapes regex metacharacters in tags", () => {
    const filter = buildTimelineFilter({ tag: "a.b*c" });
    assert.equal(filter.category.$regex.source, "^a\\.b\\*c$");
  });

  it("clampLimit floors, ceilings and defaults", () => {
    assert.equal(clampLimit(undefined), 20);
    assert.equal(clampLimit("0"), 20);
    assert.equal(clampLimit("nonsense"), 20);
    assert.equal(clampLimit("5"), 5);
    assert.equal(clampLimit("9999"), 100);
    assert.equal(clampLimit(undefined, 40), 40, "callers supply their own default (F-2)");
  });
});

describe("core/timeline — reads", () => {
  beforeEach(async () => {
    await ensureReceivedAtIndexes(mongo.collections);
    await backfillReceivedAt(mongo.collections);
    await backfillReadAt(mongo.collections);
  });

  it("orders by arrival, so the late-arriving post is FIRST (DD-1)", async () => {
    const { items } = await getTimeline(mongo.collections, { limit: 50 });

    assert.equal(
      items[0].uid,
      "https://remote.example/notes/late",
      "a post that federates in late appears where it arrived — at the top",
    );
  });

  it("home surfaces followers-only posts (DD-4)", async () => {
    const { items } = await getTimeline(mongo.collections, { limit: 50 });
    const seen = new Set(items.map((i) => i.visibility));

    assert.ok(seen.has("private"), "followers-only must be visible");
    assert.ok(!seen.has("direct"));
  });

  it("normalises published to an ISO string", async () => {
    await mongo.collections.ap_timeline.updateOne(
      { uid: "https://remote.example/notes/1" },
      { $set: { published: new Date("2026-08-01T09:00:00Z") } },
    );

    const { items } = await getTimeline(mongo.collections, { limit: 50 });

    for (const item of items) {
      assert.equal(typeof item.published, "string");
    }
  });

  it("paginates without repeating or skipping", async () => {
    const first = await getTimeline(mongo.collections, { limit: 5 });
    assert.equal(first.items.length, 5);
    assert.ok(first.before, "a full page must expose a cursor");

    const second = await getTimeline(mongo.collections, {
      limit: 5,
      before: first.before,
    });

    const firstIds = new Set(first.items.map((i) => i.uid));
    assert.ok(
      second.items.every((i) => !firstIds.has(i.uid)),
      "pages must not overlap",
    );
  });

  it("returns no cursor when the page is not full", async () => {
    const { before } = await getTimeline(mongo.collections, { limit: 500 });
    assert.equal(before, null);
  });

  it("cursors are opaque strings, never ObjectIds (DD-2)", async () => {
    const { before, after } = await getTimeline(mongo.collections, { limit: 5 });

    assert.equal(typeof before, "string");
    assert.equal(typeof after, "string");
  });

  it("a malformed cursor degrades to the first page, not a crash", async () => {
    const clean = await getTimeline(mongo.collections, { limit: 5 });
    const junk = await getTimeline(mongo.collections, {
      limit: 5,
      before: "not-a-cursor",
    });

    assert.deepEqual(
      junk.items.map((i) => i.uid),
      clean.items.map((i) => i.uid),
    );
  });

  it("getItem resolves by uid or url (DD-5: URI is identity)", async () => {
    const byUid = await getItem(mongo.collections, "https://remote.example/notes/1");
    assert.ok(byUid);
    assert.equal(byUid.uid, "https://remote.example/notes/1");
  });

  it("countNewer counts only items after the cursor", async () => {
    const page = await getTimeline(mongo.collections, { limit: 5 });
    const newer = await countNewer(mongo.collections, page.after);

    assert.equal(newer, 0, "nothing is newer than the newest item");
  });
});

describe("core/timeline — read state (DD-3)", () => {
  beforeEach(async () => {
    await ensureReceivedAtIndexes(mongo.collections);
    await backfillReceivedAt(mongo.collections);
    await backfillReadAt(mongo.collections);
  });

  it("markRead sets readAt and is idempotent", async () => {
    const uid = "https://remote.example/notes/1";

    const first = await markRead(mongo.collections, [uid]);
    assert.equal(first, 1);

    const second = await markRead(mongo.collections, [uid]);
    assert.equal(second, 0, "marking an already-read item changes nothing");

    const doc = await mongo.collections.ap_timeline.findOne({ uid });
    assert.ok(doc.readAt);
    assert.equal(doc.read, true, "legacy field dual-written during M-1a");
  });

  it("countUnread drops as items are marked", async () => {
    const before = await countUnread(mongo.collections);
    await markRead(mongo.collections, ["https://remote.example/notes/1"]);
    const after = await countUnread(mongo.collections);

    assert.equal(after, before - 1);
  });

  it("unreadOnly filters on readAt", async () => {
    const all = await getTimeline(mongo.collections, { limit: 50 });
    const unread = await getTimeline(mongo.collections, {
      limit: 50,
      unreadOnly: true,
    });

    assert.ok(unread.items.length < all.items.length);
    assert.ok(unread.items.every((i) => i.readAt === null));
  });
});
