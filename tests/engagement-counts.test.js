/**
 * Engagement counts — one rule, both surfaces (beta.6).
 *
 * Counts came only from a snapshot taken at ingest (often empty: many servers
 * hide the totals) and never moved: our own favourite/boost didn't count, and
 * likes/boosts our posts received were never reflected. Moshidon showed 0/0
 * after boosting; the reader card showed the same stale snapshot.
 *
 * Rule (core/interactions#getEngagementCounts):
 *   our posts   → distinct actors in the inbound Like/Announce activity log
 *                 (Undo deletes the log entry, so un-likes count down)
 *   other posts → ingest snapshot + our own like/boost; unknown stays null
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";
import { seed, PROFILE } from "./helpers/fixtures.js";
import { getEngagementCounts } from "../lib/core/interactions.js";
import { postProcessItems } from "../lib/item-processing.js";
import { accountId } from "../lib/mastodon/helpers/id-mapping.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

const OURS = "https://local.example/notes/2026/09/13/d26d9";
const THEIRS = "https://remote.example/notes/theirs";

const ownItem = { uid: OURS, url: OURS, type: "note", author: { url: PROFILE.url } };
const otherItem = {
  uid: THEIRS,
  url: THEIRS,
  type: "note",
  author: { url: "https://remote.example/users/a" },
  counts: { replies: null, likes: 5, boosts: null },
};

beforeEach(async () => {
  await mongo.reset();
  await seed(mongo.collections);
  await mongo.collections.ap_activities.insertMany([
    { direction: "inbound", type: "Like", actorUrl: "https://a.example/u", objectUrl: OURS },
    { direction: "inbound", type: "Like", actorUrl: "https://b.example/u", objectUrl: OURS },
    { direction: "inbound", type: "Like", actorUrl: "https://b.example/u", objectUrl: OURS }, // duplicate actor
    { direction: "inbound", type: "Announce", actorUrl: "https://c.example/u", objectUrl: OURS },
    { direction: "outbound", type: "Like", actorUrl: PROFILE.url, objectUrl: OURS }, // not received
  ]);
});

describe("getEngagementCounts", () => {
  it("our post: distinct inbound likers and boosters", async () => {
    const counts = await getEngagementCounts(mongo.collections, [ownItem]);
    assert.deepEqual(counts.get(OURS), { likes: 2, boosts: 1 });
  });

  it("their post: snapshot plus our own interaction; unknown stays unknown", async () => {
    const counts = await getEngagementCounts(mongo.collections, [otherItem], {
      favouritedIds: new Set([THEIRS]),
      rebloggedIds: new Set(),
    });
    assert.deepEqual(counts.get(THEIRS), { likes: 6, boosts: null });

    const boosted = await getEngagementCounts(mongo.collections, [otherItem], {
      favouritedIds: new Set(),
      rebloggedIds: new Set([THEIRS]),
    });
    assert.deepEqual(boosted.get(THEIRS), { likes: 5, boosts: 1 });
  });
});

describe("both surfaces use the rule", () => {
  it("Mastodon status shows our post's received favourites and reblogs", async () => {
    await mongo.collections.ap_timeline.insertOne({
      ...ownItem,
      content: { text: "mine", html: "<p>mine</p>" },
      published: "2026-09-13T19:00:00.000Z",
      receivedAt: "2026-09-13T19:00:00.000Z",
      visibility: "public",
    });
    const row = await mongo.collections.ap_timeline.findOne({ uid: OURS });
    const app = makeMastodonApp(mongo.collections);

    const res = await request(app).get(`/api/v1/statuses/${row._id}`).set("Authorization", BEARER).expect(200);
    assert.equal(res.body.favourites_count, 2);
    assert.equal(res.body.reblogs_count, 1);
  });

  it("Mastodon profile statuses and notifications carry the same counts", async () => {
    await mongo.collections.ap_timeline.insertOne({
      ...ownItem,
      content: { text: "mine", html: "<p>mine</p>" },
      published: "2026-09-13T19:00:00.000Z",
      receivedAt: "2026-09-13T19:00:00.000Z",
      visibility: "public",
    });
    await mongo.collections.ap_notifications.insertOne({
      uid: "https://a.example/likes/9",
      type: "like",
      actorUrl: "https://a.example/u",
      targetUrl: OURS,
      published: "2026-09-13T20:00:00.000Z",
      createdAt: "2026-09-13T20:00:00.000Z",
      readAt: null,
      read: false,
    });
    const app = makeMastodonApp(mongo.collections);

    const statuses = await request(app)
      .get(`/api/v1/accounts/${accountId(PROFILE)}/statuses`)
      .expect(200);
    const mine = statuses.body.find((s) => s.uri === OURS);
    assert.equal(mine.favourites_count, 2);
    assert.equal(mine.reblogs_count, 1);

    const notifs = await request(app).get("/api/v1/notifications").set("Authorization", BEARER).expect(200);
    const fav = notifs.body.find((n) => n.status?.uri === OURS);
    assert.equal(fav.status.favourites_count, 2);
  });

  it("reader pipeline puts the same counts on the item", async () => {
    const { items } = await postProcessItems([structuredClone(ownItem)], {
      interactionsCol: mongo.collections.ap_interactions,
      collections: mongo.collections,
    });
    assert.equal(items[0].counts.likes, 2);
    assert.equal(items[0].counts.boosts, 1);
  });
});
