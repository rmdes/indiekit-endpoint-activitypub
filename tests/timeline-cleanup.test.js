/**
 * Timeline retention keeps what the feed shows (DD-1: arrival order).
 *
 * cleanupTimeline kept the newest N remote rows by `published` while every
 * feed orders by `receivedAt`. Anything that arrives with an old date — a boost
 * of an older post, a late delivery, fetched thread context — sat at the top of
 * the timeline and was the first thing deleted on the next startup/daily run:
 * a client holding it got "record not found".
 *
 * Replies to our own posts (isContext rows since beta.6) are kept regardless:
 * they are the conversation on our posts, not feed volume.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { cleanupTimeline } from "../lib/timeline-cleanup.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

const OWNER = "https://local.example/";

beforeEach(async () => {
  await mongo.reset();
  await mongo.collections.ap_profile.insertOne({ url: OWNER, name: "Rick" });
});

const remote = (n, { receivedAt, published, ...extra }) => ({
  uid: `https://remote.example/notes/${n}`,
  url: `https://remote.example/notes/${n}`,
  type: "note",
  author: { url: "https://remote.example/users/a" },
  receivedAt,
  published,
  ...extra,
});

describe("cleanupTimeline", () => {
  it("keeps the newest arrivals, even when their published date is old", async () => {
    await mongo.collections.ap_timeline.insertMany([
      // arrived last, published long ago (e.g. a boost of an old post)
      remote("fresh-old-date", { receivedAt: "2026-09-14T08:00:00.000Z", published: "2025-01-01T00:00:00.000Z" }),
      remote("middle", { receivedAt: "2026-09-14T07:00:00.000Z", published: "2026-09-14T07:00:00.000Z" }),
      // arrived first, newest published date
      remote("stale-new-date", { receivedAt: "2026-09-10T00:00:00.000Z", published: "2026-09-14T09:00:00.000Z" }),
    ]);

    await cleanupTimeline(mongo.collections, 2);

    const kept = (await mongo.collections.ap_timeline.find({}).toArray()).map((r) => r.uid).sort();
    assert.deepEqual(kept, [
      "https://remote.example/notes/fresh-old-date",
      "https://remote.example/notes/middle",
    ]);
  });

  it("never removes replies to our own posts", async () => {
    await mongo.collections.ap_timeline.insertMany([
      remote("feed-1", { receivedAt: "2026-09-14T08:00:00.000Z", published: "2026-09-14T08:00:00.000Z" }),
      remote("reply-to-us", {
        receivedAt: "2026-09-01T00:00:00.000Z",
        published: "2026-09-01T00:00:00.000Z",
        isContext: true,
        inReplyTo: "https://local.example/notes/2026/09/13/d26d9",
      }),
      remote("old-feed", { receivedAt: "2026-09-02T00:00:00.000Z", published: "2026-09-02T00:00:00.000Z" }),
    ]);

    await cleanupTimeline(mongo.collections, 1);

    const kept = (await mongo.collections.ap_timeline.find({}).toArray()).map((r) => r.uid).sort();
    assert.deepEqual(kept, [
      "https://remote.example/notes/feed-1",
      "https://remote.example/notes/reply-to-us",
    ]);
  });
});
