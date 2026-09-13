/**
 * DELETE /api/v1/statuses/:id — deleting your own post from a Mastodon client.
 *
 * Live test 2026-09-13 (rmendes.net, post notes/2026/09/13/0dd77, Moshidon):
 * the client got 200 and the post vanished from its timeline, but
 *   1. Micropub's delete threw ("Micropub delete failed … undefined") — the
 *      route called postData.delete(application, url) against a
 *      (application, publication, url) signature — so the post stayed live;
 *   2. no Delete activity was sent and no Tombstone written — followers kept it;
 *   3. ap_timeline lost the row anyway, so the UI lied about the outcome.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";
import { seed, PROFILE } from "./helpers/fixtures.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

const OWN_URL = "https://local.example/notes/2026/09/13/own";

beforeEach(async () => {
  await mongo.reset();
  await seed(mongo.collections);
  await mongo.collections.ap_timeline.insertOne({
    uid: OWN_URL,
    url: OWN_URL,
    type: "note",
    content: { text: "mine", html: "<p>mine</p>" },
    author: { name: PROFILE.name, url: PROFILE.url },
    published: "2026-09-13T19:00:00.000Z",
    receivedAt: "2026-09-13T19:00:00.000Z",
    visibility: "public",
  });
});

/** Records calls; `failDelete` makes the Micropub delete throw. */
function doubles({ exists = true, failDelete = false } = {}) {
  const calls = { read: [], delete: [], federated: [] };
  return {
    calls,
    options: {
      postStore: {
        async read(application, url) {
          calls.read.push(url);
          return exists ? { properties: { url } } : null;
        },
        async delete(...args) {
          calls.delete.push(args);
          if (failDelete) throw new Error("store unavailable");
        },
      },
      federatePostDeletion: async (url) => {
        calls.federated.push(url);
      },
    },
  };
}

async function idOfOwnPost() {
  const row = await mongo.collections.ap_timeline.findOne({ uid: OWN_URL });
  return row._id.toString();
}

describe("DELETE /api/v1/statuses/:id (own post)", () => {
  it("deletes through Micropub with (application, publication, url)", async () => {
    const { calls, options } = doubles();
    const app = makeMastodonApp(mongo.collections, options);

    await request(app)
      .delete(`/api/v1/statuses/${await idOfOwnPost()}`)
      .set("Authorization", BEARER)
      .expect(200);

    assert.equal(calls.delete.length, 1);
    assert.equal(calls.delete[0].length, 3, "Micropub delete takes three arguments");
    assert.equal(calls.delete[0][2], OWN_URL, "the URL is the third argument");
  });

  it("after a Micropub delete, leaves federation to the syndicator hook (no double Delete)", async () => {
    // Micropub's postContent.delete calls the AP syndicator's delete(url) hook,
    // which writes the Tombstone and sends Delete. Federating again here would
    // send followers two Deletes.
    const { calls, options } = doubles();
    const app = makeMastodonApp(mongo.collections, options);

    await request(app)
      .delete(`/api/v1/statuses/${await idOfOwnPost()}`)
      .set("Authorization", BEARER)
      .expect(200);

    assert.deepEqual(calls.federated, []);
    assert.equal(await mongo.collections.ap_timeline.findOne({ uid: OWN_URL }), null);
  });

  it("a failed Micropub delete is an error, not a silent 200 — nothing else changes", async () => {
    const { calls, options } = doubles({ failDelete: true });
    const app = makeMastodonApp(mongo.collections, options);

    const res = await request(app)
      .delete(`/api/v1/statuses/${await idOfOwnPost()}`)
      .set("Authorization", BEARER);

    assert.ok(res.status >= 500, `expected a server error, got ${res.status}`);
    assert.deepEqual(calls.federated, [], "must not federate a delete that did not happen");
    assert.ok(
      await mongo.collections.ap_timeline.findOne({ uid: OWN_URL }),
      "timeline row kept so the client and the site agree",
    );
  });

  it("a post Micropub does not know (legacy) is still removed and federated", async () => {
    const { calls, options } = doubles({ exists: false });
    const app = makeMastodonApp(mongo.collections, options);

    await request(app)
      .delete(`/api/v1/statuses/${await idOfOwnPost()}`)
      .set("Authorization", BEARER)
      .expect(200);

    assert.equal(calls.delete.length, 0);
    assert.deepEqual(calls.federated, [OWN_URL]);
  });
});
