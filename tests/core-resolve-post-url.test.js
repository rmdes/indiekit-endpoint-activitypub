/**
 * core/posts#resolvePostUrl — what an AS2 request for one of our URLs gets.
 *
 * A live post, a Tombstone (FEP-4f05) for a deleted one, or nothing. Requests
 * can arrive with or without a trailing slash (nginx AS2 passthrough); the post
 * lookup already tolerated both (v3.13.13) but the Tombstone lookup did not, so
 * a deleted post requested as `/path/` answered 404 instead of 410 Gone.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { resolvePostUrl } from "../lib/core/posts.js";

let mongo;
let collections;

before(async () => {
  mongo = await withMongo();
  collections = { ...mongo.collections, posts: mongo.db.collection("posts") };
});

after(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.reset();
  await collections.posts.deleteMany({});
});

const LIVE = "https://local.example/notes/live";
const GONE = "https://local.example/notes/gone";

describe("resolvePostUrl", () => {
  beforeEach(async () => {
    await collections.posts.insertMany([
      { properties: { url: LIVE, "post-type": "note" } },
      { properties: { url: GONE, "post-type": "note", deleted: "2026-08-02T00:00:00.000Z" } },
    ]);
    await mongo.collections.ap_tombstones.insertOne({
      url: GONE,
      formerType: "Note",
      deleted: "2026-08-02T00:00:00.000Z",
    });
  });

  it("finds a live post with or without a trailing slash", async () => {
    assert.equal((await resolvePostUrl(collections, LIVE)).post?.properties.url, LIVE);
    assert.equal((await resolvePostUrl(collections, `${LIVE}/`)).post?.properties.url, LIVE);
  });

  it("returns the tombstone for a deleted post, with or without a trailing slash", async () => {
    for (const url of [GONE, `${GONE}/`]) {
      const result = await resolvePostUrl(collections, url);
      assert.equal(result.post, null, url);
      assert.equal(result.tombstone?.formerType, "Note", url);
    }
  });

  it("returns nothing for a URL that is not ours", async () => {
    assert.deepEqual(await resolvePostUrl(collections, "https://local.example/nope"), {
      post: null,
      tombstone: null,
    });
  });
});
