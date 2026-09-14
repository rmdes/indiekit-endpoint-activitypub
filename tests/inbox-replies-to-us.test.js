/**
 * Replies and mentions from accounts we don't follow must be addressable.
 *
 * Before beta.6 handleCreate stored such a post ONLY as a notification. Nothing
 * could show it in a thread (reader post-detail and Mastodon /context both read
 * ap_timeline), and the Mastodon notification serializer invented a status
 * whose id was the notification's, so favourite/boost/context on it → 404
 * ("record not found" in Moshidon, 2026-09-14).
 *
 * Now the post is also stored as an isContext row: out of every feed, but a
 * real status with a real id that thread views list.
 *
 * Driven end to end through handleCreate with an offline document loader
 * (Fedify's preloaded JSON-LD contexts; any other fetch fails, as a remote
 * lookup would in a sandbox).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { preloadedContexts } from "@fedify/fedify";

import { withMongo } from "./helpers/mongo.js";
import { handleCreate } from "../lib/inbox-handlers.js";

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

const PUB = "https://local.example/";
const OUR_ACTOR = "https://local.example/activitypub/users/rick";
const STRANGER = "https://remote.example/users/stranger";
const OUR_POST = "https://local.example/notes/2026/09/13/d26d9";

const offlineLoader = async (url) => {
  if (preloadedContexts[url]) {
    return { contextUrl: null, documentUrl: url, document: preloadedContexts[url] };
  }
  throw new Error(`offline: ${url}`);
};

const ctx = {
  getDocumentLoader: async () => offlineLoader,
  getActorUri: () => new URL(OUR_ACTOR),
  getFollowersUri: () => new URL(`${OUR_ACTOR}/followers`),
};

function collections() {
  return { ...mongo.collections, _publicationUrl: PUB };
}

function createActivity({ id, inReplyTo, mentionUs = false }) {
  const note = {
    type: "Note",
    id,
    url: id,
    attributedTo: STRANGER,
    content: "<p>nice post</p>",
    published: "2026-09-14T05:21:00Z",
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [OUR_ACTOR],
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(mentionUs ? { tag: [{ type: "Mention", href: OUR_ACTOR, name: "@rick@local.example" }] } : {}),
  };
  return {
    rawJson: {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Create",
      id: `${id}#create`,
      actor: {
        type: "Person",
        id: STRANGER,
        preferredUsername: "stranger",
        name: "A Stranger",
        inbox: `${STRANGER}/inbox`,
      },
      object: note,
    },
  };
}

describe("handleCreate — posts that notify us, from accounts we don't follow", () => {
  it("a reply to our post is stored as an addressable isContext row", async () => {
    const id = "https://remote.example/notes/reply-1";
    await handleCreate(createActivity({ id, inReplyTo: OUR_POST }), collections(), ctx, "rick");

    const row = await mongo.collections.ap_timeline.findOne({ uid: id });
    assert.ok(row, "reply must exist in ap_timeline");
    assert.equal(row.isContext, true, "kept out of feeds");
    assert.equal(row.inReplyTo, OUR_POST, "listed under our post's thread");
    assert.ok(row.receivedAt, "stamped at ingest");

    assert.ok(
      await mongo.collections.ap_notifications.findOne({ type: "reply" }),
      "the notification is still created",
    );
  });

  it("a mention of us (not a reply) is stored as an isContext row too", async () => {
    const id = "https://remote.example/notes/mention-1";
    await handleCreate(createActivity({ id, mentionUs: true }), collections(), ctx, "rick");

    const row = await mongo.collections.ap_timeline.findOne({ uid: id });
    assert.ok(row, "mention must exist in ap_timeline");
    assert.equal(row.isContext, true);
  });

  it("an unrelated post from a stranger is not stored", async () => {
    const id = "https://remote.example/notes/unrelated-1";
    await handleCreate(
      createActivity({ id, inReplyTo: "https://elsewhere.example/notes/9" }),
      collections(),
      ctx,
      "rick",
    );

    assert.equal(await mongo.collections.ap_timeline.findOne({ uid: id }), null);
  });
});
