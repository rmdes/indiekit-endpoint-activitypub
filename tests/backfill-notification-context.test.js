/**
 * Backfill: replies/mentions that exist only as notifications get thread rows.
 *
 * Notifications received before beta.6 have no ap_timeline row (see
 * inbox-replies-to-us.test.js for the ingest fix). This startup migration
 * builds one from the notification's own fields so old replies become
 * addressable too. Visibility is unknown for these, so they are stored
 * PRIVATE: the owner sees them, anonymous /context readers never do.
 *
 * The surface tests prove both lanes: the Mastodon notification now carries a
 * status id the status routes resolve, and our post's thread lists the reply
 * in /context and in the reader's descendants.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";
import { seed, PROFILE } from "./helpers/fixtures.js";
import { backfillNotificationContext } from "../lib/migrations/single-lane-core.js";
import { getDescendants } from "../lib/core/threads.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

const OUR_POST = "https://local.example/notes/2026/09/13/d26d9";
const REPLY = "https://remote.example/notes/old-reply";
const MENTION = "https://remote.example/notes/old-mention";

beforeEach(async () => {
  await mongo.reset();
  await seed(mongo.collections);
  await mongo.collections.ap_timeline.insertOne({
    uid: OUR_POST,
    url: OUR_POST,
    type: "note",
    content: { text: "mine", html: "<p>mine</p>" },
    author: { name: PROFILE.name, url: PROFILE.url },
    published: "2026-09-13T19:00:00.000Z",
    receivedAt: "2026-09-13T19:00:00.000Z",
    visibility: "public",
  });
  await mongo.collections.ap_notifications.insertMany([
    {
      uid: REPLY,
      url: REPLY,
      type: "reply",
      actorUrl: "https://remote.example/users/stranger",
      actorName: "A Stranger",
      actorPhoto: "https://remote.example/avatar.png",
      actorHandle: "@stranger@remote.example",
      targetUrl: OUR_POST,
      content: { text: "nice post", html: "<p>nice post</p>" },
      published: "2026-09-14T05:21:00.000Z",
      createdAt: "2026-09-14T05:21:38.000Z",
      readAt: null,
    },
    {
      uid: MENTION,
      url: MENTION,
      type: "mention",
      actorUrl: "https://remote.example/users/other",
      actorName: "Other",
      content: { text: "hey @rick", html: "<p>hey @rick</p>" },
      published: "2026-09-14T06:00:00.000Z",
      createdAt: "2026-09-14T06:00:05.000Z",
      readAt: null,
    },
  ]);
});

describe("backfillNotificationContext", () => {
  it("creates private isContext rows from reply and mention notifications", async () => {
    await backfillNotificationContext(mongo.collections);

    const reply = await mongo.collections.ap_timeline.findOne({ uid: REPLY });
    assert.ok(reply, "reply row created");
    assert.equal(reply.isContext, true);
    assert.equal(reply.visibility, "private", "unknown visibility never becomes public");
    assert.equal(reply.inReplyTo, OUR_POST);
    assert.equal(reply.author.url, "https://remote.example/users/stranger");
    assert.equal(reply.content.html, "<p>nice post</p>");
    assert.equal(reply.receivedAt, "2026-09-14T05:21:38.000Z");

    assert.ok(await mongo.collections.ap_timeline.findOne({ uid: MENTION }), "mention row created");
  });

  it("is idempotent and never touches an existing row", async () => {
    await mongo.collections.ap_timeline.insertOne({
      uid: MENTION,
      url: MENTION,
      type: "note",
      visibility: "public",
      content: { html: "<p>already stored by a feed path</p>" },
    });

    await backfillNotificationContext(mongo.collections);
    await backfillNotificationContext(mongo.collections);

    assert.equal(await mongo.collections.ap_timeline.countDocuments({ uid: REPLY }), 1);
    const mention = await mongo.collections.ap_timeline.findOne({ uid: MENTION });
    assert.equal(mention.visibility, "public", "existing row untouched");
    assert.equal(mention.isContext, undefined);
  });

  it("runs once: a later restart does not rescan notifications", async () => {
    await backfillNotificationContext(mongo.collections);
    await mongo.collections.ap_timeline.deleteMany({ isContext: true });

    assert.equal(await backfillNotificationContext(mongo.collections), 0);
    assert.equal(await mongo.collections.ap_timeline.countDocuments({ isContext: true }), 0);
  });
});

describe("after the backfill, both surfaces can reach the reply", () => {
  it("Mastodon: the notification's status id resolves", async () => {
    await backfillNotificationContext(mongo.collections);
    const app = makeMastodonApp(mongo.collections);

    const res = await request(app).get("/api/v1/notifications").set("Authorization", BEARER).expect(200);
    const replyNotif = res.body.find((n) => n.status?.uri === REPLY);
    assert.ok(replyNotif, "reply notification has a status");

    const row = await mongo.collections.ap_timeline.findOne({ uid: REPLY });
    assert.equal(replyNotif.status.id, row._id.toString(), "status id is the timeline row, not the notification");

    await request(app)
      .get(`/api/v1/statuses/${replyNotif.status.id}`)
      .set("Authorization", BEARER)
      .expect(200);
  });

  it("Mastodon /context of our post lists the reply", async () => {
    await backfillNotificationContext(mongo.collections);
    const app = makeMastodonApp(mongo.collections);
    const ours = await mongo.collections.ap_timeline.findOne({ uid: OUR_POST });

    const res = await request(app)
      .get(`/api/v1/statuses/${ours._id}/context`)
      .set("Authorization", BEARER)
      .expect(200);

    assert.ok(res.body.descendants.some((s) => s.uri === REPLY));
  });

  it("reader: our post's descendants include the reply", async () => {
    await backfillNotificationContext(mongo.collections);

    const replies = await getDescendants(mongo.collections, { uid: OUR_POST, url: OUR_POST });
    assert.ok(replies.some((r) => r.uid === REPLY));
  });
});
