/**
 * Keyset pagination must follow the SORT key, not `_id`.
 *
 * The timeline sorts on `receivedAt` (DD-1) and notifications on `published`,
 * but cursors are ObjectId hex (DD-2: the Mastodon wire format). When the sort
 * key and `_id` disagree — `isContext` ancestors inherit a descendant's
 * `receivedAt`, backfills write old rows late — a plain `_id` range skips or
 * repeats items. These fixtures make the two orders exactly opposite, which is
 * the worst case, and walk every page in both directions.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { ObjectId } from "mongodb";

import { withMongo } from "./helpers/mongo.js";
import { getTimeline, countNewer } from "../lib/core/timeline.js";
import { getNotifications } from "../lib/core/notifications.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.reset();
});

const N = 7;

/**
 * Rows whose `_id` ascends while the sort key DEScends: row 0 has the oldest
 * `_id` and the newest timestamp.
 */
function inverted(field, extra) {
  const base = Date.parse("2026-08-01T00:00:00.000Z");
  return Array.from({ length: N }, (_, i) => ({
    _id: ObjectId.createFromTime(Math.floor(base / 1000) + i),
    uid: `https://remote.example/${field}/${i}`,
    [field]: new Date(base + (N - i) * 60_000).toISOString(),
    ...extra(i),
  }));
}

/** Follow `before` cursors to the end, collecting uids. */
async function walkBackwards(fetchPage, limit) {
  const seen = [];
  let cursor;
  for (let guard = 0; guard < N + 2; guard++) {
    const page = await fetchPage({ limit, before: cursor });
    seen.push(...page.items.map((x) => x.uid));
    if (!page.before) break;
    cursor = page.before;
  }
  return seen;
}

describe("timeline pagination follows receivedAt", () => {
  const rows = inverted("receivedAt", (i) => ({
    type: "note",
    visibility: "public",
    published: "2026-08-01T00:00:00.000Z",
    readAt: null,
    author: { url: `https://remote.example/users/${i}` },
  }));
  const expected = rows.map((r) => r.uid); // row 0 is newest

  it("walking `before` visits every item once, newest first", async () => {
    await mongo.collections.ap_timeline.insertMany(rows);

    for (const limit of [1, 2, 3]) {
      const seen = await walkBackwards(
        (page) => getTimeline(mongo.collections, { feed: "home", ...page }),
        limit,
      );
      assert.deepEqual(seen, expected, `limit=${limit}`);
    }
  });

  it("`after` returns exactly the items newer than the cursor", async () => {
    await mongo.collections.ap_timeline.insertMany(rows);

    const page = await getTimeline(mongo.collections, {
      feed: "home",
      limit: 20,
      after: rows[3]._id.toString(),
    });
    assert.deepEqual(
      page.items.map((x) => x.uid),
      expected.slice(0, 3),
    );
  });

  it("`since` returns the items newer than the cursor, newest first", async () => {
    await mongo.collections.ap_timeline.insertMany(rows);

    const page = await getTimeline(mongo.collections, {
      feed: "home",
      limit: 2,
      since: rows[3]._id.toString(),
    });
    // since = the page immediately above the cursor, still presented newest-first
    assert.deepEqual(
      page.items.map((x) => x.uid),
      expected.slice(1, 3),
    );
  });

  it("countNewer counts by receivedAt, not _id", async () => {
    await mongo.collections.ap_timeline.insertMany(rows);

    // rows[2]: two items are newer by receivedAt, four have a larger _id —
    // asymmetric on purpose so an _id-based count cannot pass by coincidence.
    assert.equal(
      await countNewer(mongo.collections, rows[2]._id.toString(), { feed: "home" }),
      2,
    );
  });

  it("an `onlyMedia` filter (which uses $or) still pages correctly", async () => {
    const media = rows.map((r) => ({ ...r, photo: [{ url: "https://x/p.jpg" }] }));
    await mongo.collections.ap_timeline.insertMany(media);

    const seen = await walkBackwards(
      (page) =>
        getTimeline(mongo.collections, { feed: "home", onlyMedia: true, ...page }),
      2,
    );
    assert.deepEqual(seen, expected);
  });
});

describe("notification pagination follows published", () => {
  const rows = inverted("published", () => ({
    type: "like",
    actorUrl: "https://remote.example/users/a",
    objectUrl: "https://local.example/posts/1",
    readAt: null,
  }));
  const expected = rows.map((r) => r.uid);

  it("walking `before` visits every notification once, newest first", async () => {
    await mongo.collections.ap_notifications.insertMany(rows);

    for (const limit of [1, 2, 3]) {
      const seen = await walkBackwards(
        (page) => getNotifications(mongo.collections, page),
        limit,
      );
      assert.deepEqual(seen, expected, `limit=${limit}`);
    }
  });
});
