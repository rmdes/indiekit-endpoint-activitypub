/**
 * Followed hashtags — one model for both lanes.
 *
 * A tag can be followed LOCALLY (`followedAt`: matching posts from the inbox
 * land in the timeline) and/or GLOBALLY (`globalFollow`: a Follow sent to the
 * tags.pub relay actor). The two are independent; removing one must keep the
 * other.
 *
 * Found 2026-09-13: the reader used that model (lib/storage/followed-tags.js)
 * while the Mastodon API used a lossy copy in core/tags.js — it wrote
 * `createdAt` instead of `followedAt` (so Phanpy follows looked unfollowed in
 * the reader), counted global-only follows as followed, and deleted the whole
 * document on unfollow (orphaning an active tags.pub follow).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";
import { seed } from "./helpers/fixtures.js";
import {
  followTag,
  unfollowTag,
  isTagFollowed,
  getFollowedTags,
  setGlobalFollow,
  removeGlobalFollow,
} from "../lib/core/tags.js";
import { backfillTagFollowedAt } from "../lib/migrations/single-lane-core.js";

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

const doc = (tag) => mongo.collections.ap_followed_tags.findOne({ tag });

describe("core/tags — local and global follows are independent", () => {
  it("a local follow records followedAt and counts as followed", async () => {
    await followTag(mongo.collections, "#IndieWeb");

    assert.ok((await doc("indieweb")).followedAt, "reader reads followedAt");
    assert.equal(await isTagFollowed(mongo.collections, "indieweb"), true);
  });

  it("a global-only follow is listed but is not a local follow", async () => {
    await setGlobalFollow(mongo.collections, "fediverse", "https://tags.pub/user/fediverse");

    assert.equal(await isTagFollowed(mongo.collections, "fediverse"), false);
    const listed = await getFollowedTags(mongo.collections);
    assert.deepEqual(listed.map((t) => t.tag), ["fediverse"]);
  });

  it("unfollowing locally keeps an active global follow", async () => {
    await followTag(mongo.collections, "indieweb");
    await setGlobalFollow(mongo.collections, "indieweb", "https://tags.pub/user/indieweb");

    await unfollowTag(mongo.collections, "indieweb");

    const kept = await doc("indieweb");
    assert.ok(kept, "document must survive — the tags.pub follow is still live");
    assert.equal(kept.globalFollow, true);
    assert.equal(await isTagFollowed(mongo.collections, "indieweb"), false);
  });

  it("removing the global follow keeps an active local follow", async () => {
    await followTag(mongo.collections, "indieweb");
    await setGlobalFollow(mongo.collections, "indieweb", "https://tags.pub/user/indieweb");

    await removeGlobalFollow(mongo.collections, "indieweb");

    const kept = await doc("indieweb");
    assert.equal(kept.globalFollow, undefined);
    assert.equal(await isTagFollowed(mongo.collections, "indieweb"), true);
  });

  it("removing the last half deletes the document", async () => {
    await followTag(mongo.collections, "indieweb");
    await unfollowTag(mongo.collections, "indieweb");

    assert.equal(await doc("indieweb"), null);
  });
});

describe("backfillTagFollowedAt — rows written by the old core/tags", () => {
  it("promotes createdAt to followedAt, leaves global-only rows alone", async () => {
    await mongo.collections.ap_followed_tags.insertMany([
      { tag: "old", createdAt: "2026-08-01T00:00:00.000Z" },
      { tag: "relay", globalFollow: true, globalActorUrl: "https://tags.pub/user/relay" },
      { tag: "both", createdAt: "2026-08-02T00:00:00.000Z", globalFollow: true },
      { tag: "modern", followedAt: "2026-08-03T00:00:00.000Z" },
    ]);

    await backfillTagFollowedAt(mongo.collections);
    await backfillTagFollowedAt(mongo.collections); // idempotent

    assert.equal((await doc("old")).followedAt, "2026-08-01T00:00:00.000Z");
    assert.equal((await doc("relay")).followedAt, undefined);
    assert.equal((await doc("both")).followedAt, "2026-08-02T00:00:00.000Z");
    assert.equal((await doc("modern")).followedAt, "2026-08-03T00:00:00.000Z");
  });
});

describe("parity — a tag followed in Phanpy is followed in the reader", () => {
  it("POST /api/v1/tags/:id/follow is visible to the reader's model", async () => {
    await seed(mongo.collections);
    const app = makeMastodonApp(mongo.collections);

    await request(app)
      .post("/api/v1/tags/Solarpunk/follow")
      .set("Authorization", BEARER)
      .expect(200);

    assert.ok((await doc("solarpunk")).followedAt);
  });

  it("GET /api/v1/tags/:id reports a global-only tag as not followed", async () => {
    await seed(mongo.collections);
    await setGlobalFollow(mongo.collections, "relayonly", "https://tags.pub/user/relayonly");
    const app = makeMastodonApp(mongo.collections);

    const res = await request(app).get("/api/v1/tags/relayonly").expect(200);
    assert.equal(res.body.following, false);
  });
});
