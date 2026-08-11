/**
 * Stage 0.4 — ROUTE-LEVEL INTEGRATION.
 *
 * Both lanes exercised over real HTTP against a real MongoDB. The defects this
 * plan targets live in query construction and route wiring, so the surfaces
 * have to be driven as mounted — not imported piecemeal.
 *
 * The reader half matters most here: `api-timeline.js` returns JSON containing
 * server-rendered HTML, so a function-level test never touches its rendering
 * path. Stage 2 rewrites this controller into an adapter over core/timeline.js,
 * and these tests are what will catch the rewrite changing its output.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { seed } from "./helpers/fixtures.js";
import { makeReaderApp } from "./helpers/reader-app.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";

let mongo;
let reader;
let mastodon;

before(async () => {
  mongo = await withMongo();
  await seed(mongo.collections);
  reader = makeReaderApp(mongo.collectionMap);
  mastodon = makeMastodonApp(mongo.collections);
});

after(async () => {
  await mongo?.stop();
});

/**
 * Count rendered item cards in the reader's HTML payload.
 *
 * The card root is `<article class="ap-card…" data-uid="…">` — see
 * views/partials/ap-item-card.njk:9. Note the partial renders NOTHING for an
 * item with no content, title or media, so this counts rendered cards rather
 * than matched rows.
 */
function cardCount(html) {
  return (html.match(/<article class="ap-card/g) || []).length;
}

describe("integration: reader timeline endpoint", () => {
  it("returns JSON carrying rendered HTML and a cursor", async () => {
    const res = await request(reader)
      .get("/admin/reader/api/timeline")
      .expect(200);

    assert.ok("html" in res.body, "response must carry rendered cards");
    assert.ok("before" in res.body, "response must carry a pagination cursor");
    assert.ok(res.body.html.length > 0);
  });

  it("renders without template errors", async () => {
    const res = await request(reader)
      .get("/admin/reader/api/timeline")
      .expect(200);

    assert.ok(
      !/Template render error|\[object Object\]|undefined/i.test(res.body.html),
      "rendered HTML must not leak template errors or undefined values",
    );
  });

  it("the notes tab excludes replies and non-note types", async () => {
    const notes = await request(reader)
      .get("/admin/reader/api/timeline?tab=notes")
      .expect(200);

    const articles = await request(reader)
      .get("/admin/reader/api/timeline?tab=articles")
      .expect(200);

    assert.notEqual(
      notes.body.html,
      articles.body.html,
      "tab filtering must actually change the result set",
    );
  });

  it("the articles tab returns only articles", async () => {
    const res = await request(reader)
      .get("/admin/reader/api/timeline?tab=articles")
      .expect(200);

    assert.equal(cardCount(res.body.html), 1, "fixture seeds one article");
  });

  it("omits the cursor when the result set fits on one page", async () => {
    const res = await request(reader)
      .get("/admin/reader/api/timeline")
      .expect(200);

    // getTimelineItems only emits `before` when items.length === limit, and
    // api-timeline.js HARDCODES limit = 20. The fixture is smaller, so there is
    // genuinely no next page.
    //
    // NOTE for Stage 2: that hardcoded 20 is adapter-level policy sitting in a
    // controller. core/timeline.js should take limit as a parameter and let each
    // adapter supply its own (Mastodon already parses ?limit, the reader can't).
    assert.equal(res.body.before, null);
  });

  it("honours an explicit `before` cursor and returns strictly older items", async () => {
    const all = await request(reader)
      .get("/admin/reader/api/timeline")
      .expect(200);

    const total = cardCount(all.body.html);
    assert.ok(total > 2, "need enough items for the cursor to bite");

    // DD-2: `before` is now an OPAQUE cursor, not a published date. The token
    // happens to be the ObjectId hex — that is core's business, not the
    // adapter's, and the adapter passes it back unchanged.
    const pivot = await mongo.collections.ap_timeline.findOne({
      uid: "https://remote.example/notes/8",
    });

    const older = await request(reader)
      .get(
        `/admin/reader/api/timeline?before=${encodeURIComponent(pivot._id.toString())}`,
      )
      .expect(200);

    assert.ok(
      cardCount(older.body.html) < total,
      "a cursored page must be a strict subset",
    );
    assert.ok(
      !older.body.html.includes(`data-uid="${pivot.uid}"`),
      "the pivot item itself must not reappear (cursor is exclusive)",
    );
  });

  it("the unread filter narrows the result set", async () => {
    const all = await request(reader)
      .get("/admin/reader/api/timeline")
      .expect(200);

    const unread = await request(reader)
      .get("/admin/reader/api/timeline?unread=1")
      .expect(200);

    assert.ok(
      cardCount(unread.body.html) <= cardCount(all.body.html),
      "unread must be a subset",
    );
  });

  it("a tag filter narrows to matching items, case-insensitively", async () => {
    const lower = await request(reader)
      .get("/admin/reader/api/timeline?tag=activitypub")
      .expect(200);

    const upper = await request(reader)
      .get("/admin/reader/api/timeline?tag=ActivityPub")
      .expect(200);

    assert.equal(cardCount(lower.body.html), 1);
    assert.equal(cardCount(upper.body.html), 1);
  });

  it("survives a hostile tag without executing an operator", async () => {
    // getTimelineItems throws on a non-string tag; the controller must not 500
    // or, worse, pass an object through to the query.
    const res = await request(reader).get(
      "/admin/reader/api/timeline?tag[$ne]=null",
    );

    assert.notEqual(res.status, 500, `operator injection produced ${res.status}`);
  });
});

describe("integration: both lanes mounted over the same database", () => {
  it("each lane serves its own timeline successfully", async () => {
    const readerRes = await request(reader)
      .get("/admin/reader/api/timeline")
      .expect(200);

    const mastodonRes = await request(mastodon)
      .get("/api/v1/timelines/home")
      .set("Authorization", BEARER)
      .expect(200);

    assert.ok(readerRes.body.html.length > 0);
    assert.ok(mastodonRes.body.length > 0);
  });

  it(
    "both lanes return the same number of items for an unfiltered timeline",
    async () => {
      // `tab=all` is required: the reader defaults to the `notes` tab, which
      // filters to type=note AND excludes replies. Comparing that against an
      // unfiltered Mastodon home compares two different queries — the counts
      // would differ (8 vs 10) for reasons that are not a parity defect.
      const readerRes = await request(reader)
        .get("/admin/reader/api/timeline?tab=all")
        .expect(200);

      const mastodonRes = await request(mastodon)
        .get("/api/v1/timelines/home")
        .set("Authorization", BEARER)
        .expect(200);

      assert.equal(cardCount(readerRes.body.html), mastodonRes.body.length);
    },
  );

  it("a write through one lane is visible to the other", async () => {
    // Route-level proof that both surfaces share one database — the premise the
    // whole single-lane refactor rests on.
    await request(mastodon)
      .post("/api/v1/domain_blocks")
      .set("Authorization", BEARER)
      .send({ domain: "integration.example" })
      .expect(200);

    const stored = await mongo.collections.ap_blocked_servers.findOne({
      hostname: "integration.example",
    });

    assert.ok(stored, "the Mastodon write must land in the shared collection");

    await mongo.collections.ap_blocked_servers.deleteOne({
      hostname: "integration.example",
    });
  });
});
