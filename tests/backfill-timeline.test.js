/**
 * backfill-timeline copies the owner's Micropub posts into ap_timeline.
 *
 * It runs inside the startup gate — after the Stage 2 migrations — so rows it
 * inserts never get the migration's receivedAt/readAt backfill until the next
 * restart. Without receivedAt they sort after every other item and fall outside
 * cursor keysets. It must stamp the fields itself, the way the syndicator's
 * addTimelineItem path does.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { backfillTimeline } from "../lib/mastodon/backfill-timeline.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.reset();
  await mongo.db.collection("posts").deleteMany({});
});

describe("backfillTimeline", () => {
  it("stamps receivedAt (publish time) and readAt on inserted rows", async () => {
    const published = "2025-03-01T10:00:00.000Z";
    await mongo.db.collection("posts").insertOne({
      properties: {
        url: "https://local.example/notes/old",
        "post-type": "note",
        content: { text: "an old post", html: "<p>an old post</p>" },
        published,
      },
    });

    const collections = { ...mongo.collections, posts: mongo.db.collection("posts") };
    const result = await backfillTimeline(collections);
    assert.equal(result.inserted, 1);

    const row = await mongo.collections.ap_timeline.findOne({
      uid: "https://local.example/notes/old",
    });
    // An old post must not claim to have arrived now — it would jump to the
    // top of the home timeline.
    assert.equal(row.receivedAt, published);
    assert.equal(row.readAt, null);
  });
});
