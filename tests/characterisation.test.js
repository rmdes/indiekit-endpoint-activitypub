/**
 * Stage 0.2 — CHARACTERISATION SUITE.
 *
 * These tests encode what the two lanes do TODAY, bugs included. They are not
 * a specification and they are not aspirational: their only job is to make an
 * unintended behaviour change during the single-lane refactor loud.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Difference from tests/parity.test.js:                                │
 * │   parity.test.js         asserts the lanes AGREE  → fails today      │
 * │   characterisation.test  asserts each lane is UNCHANGED → passes     │
 * │                                                                       │
 * │ When the refactor deliberately changes behaviour, UPDATE the         │
 * │ characterisation and say so in the commit. A characterisation test   │
 * │ failing without an intended change is a regression.                  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * The Mastodon entity shapes below matter most: they are the wire contract
 * with Phanpy, Elk, Moshidon and Fedilab. A field silently dropped during the
 * refactor breaks four real clients with no other signal.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { seed } from "./helpers/fixtures.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";

// Post-Stage-2 these characterise lib/core/*, which BOTH lanes now call.
// The reader-specific storage functions they used to describe were deleted in
// Stage 5 — their behaviour is now core's, and several assertions below changed
// deliberately as a result. Each such change is marked.
import { getTimeline as getTimelineItems } from "../lib/core/timeline.js";
import { getNotifications } from "../lib/core/notifications.js";

let mongo;
let app;

before(async () => {
  mongo = await withMongo();
  await seed(mongo.collections);
  app = makeMastodonApp(mongo.collections);
});

after(async () => {
  await mongo?.stop();
});

// ───────────────────────────────────────────────────────────────────────────
// Reader lane — current behaviour
// ───────────────────────────────────────────────────────────────────────────

describe("characterisation: timeline core (lib/core/timeline.js)", () => {
  it("CHANGED by DD-4: includes followers-only, still excludes direct/context", async () => {
    const { items } = await getTimelineItems(mongo.collections, { limit: 50 });
    const seen = new Set(items.map((i) => i.visibility));

    // Was: `assert.ok(!seen.has("private"))` — the reader hid followers-only
    // posts the phone showed. DD-4 ratified showing them on both surfaces.
    assert.ok(seen.has("private"), "followers-only posts are now visible");
    assert.ok(!seen.has("direct"));
    assert.ok(!items.some((i) => i.isContext));
  });

  it("CHANGED by DD-1: sorts newest-first by `receivedAt`, not `published`", async () => {
    const { items } = await getTimelineItems(mongo.collections, { limit: 50 });
    const arrivals = items.map((i) => i.receivedAt);

    // Was: sorted on `published`. A post federating in three days late used to
    // land where it was published — buried, effectively invisible.
    assert.deepEqual(arrivals, [...arrivals].sort().reverse());
  });

  it("normalises `published` to an ISO string, never a Date", async () => {
    const { items } = await getTimelineItems(mongo.collections, { limit: 5 });

    for (const item of items) {
      assert.equal(
        typeof item.published,
        "string",
        "a Date reaching a Nunjucks | date filter crashes the template — " +
          "this is the workspace's canonical bug",
      );
    }
  });

  it("excludeReplies matches null, missing AND empty-string inReplyTo", async () => {
    const { items } = await getTimelineItems(mongo.collections, {
      limit: 50,
      feed: "home",
      excludeReplies: true,
    });

    assert.ok(
      !items.some((i) => i.inReplyTo),
      "no item with a truthy inReplyTo may survive excludeReplies",
    );
    assert.ok(
      items.some((i) => i.inReplyTo === ""),
      "the legacy empty-string row is a non-reply and must be KEPT",
    );
  });

  it("filters by type", async () => {
    const { items } = await getTimelineItems(mongo.collections, {
      limit: 50,
      type: "article",
    });

    assert.ok(items.length > 0);
    assert.ok(items.every((i) => i.type === "article"));
  });

  it("matches tags case-insensitively", async () => {
    const lower = await getTimelineItems(mongo.collections, { tag: "activitypub" });
    const upper = await getTimelineItems(mongo.collections, { tag: "ActivityPub" });

    assert.equal(lower.items.length, 1);
    assert.equal(upper.items.length, 1);
  });

  it("rejects non-string tag and authorUrl (operator injection guard)", async () => {
    await assert.rejects(() =>
      getTimelineItems(mongo.collections, { tag: { $ne: null } }),
    );
    await assert.rejects(() =>
      getTimelineItems(mongo.collections, { authorUrl: { $ne: null } }),
    );
  });

  it("CHANGED by F-2: limit is a parameter, not a hardcoded page size", async () => {
    const five = await getTimelineItems(mongo.collections, { limit: 5 });
    assert.equal(five.items.length, 5);
  });
});

describe("characterisation: notification core (lib/core/notifications.js)", () => {
  it("CHANGED by DD-3: filters unread on the shared `readAt`", async () => {
    const all = await getNotifications(mongo.collections, { limit: 50 });
    const unread = await getNotifications(mongo.collections, {
      limit: 50,
      unreadOnly: true,
    });

    assert.equal(all.items.length, 4);
    // Was 3, counting only the reader's `read` field. Now 2: the fixture's
    // Mastodon-dismissed notification ALSO counts as read, which is AP-D2
    // closed. One field, both surfaces.
    assert.equal(unread.items.length, 2);
  });

  it("CHANGED by DD-3: a Mastodon-dismissed notification is read here too", async () => {
    const unread = await getNotifications(mongo.collections, {
      limit: 50,
      unreadOnly: true,
    });

    // Was: asserted the opposite — that `dismissed` was ignored, which is
    // exactly the defect.
    assert.ok(
      !unread.items.some((n) => n.dismissed === true),
      "dismissing on the phone must mark it read on the desktop",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Mastodon lane — the wire contract
// ───────────────────────────────────────────────────────────────────────────

describe("characterisation: Mastodon Status entity shape", () => {
  /** Fields Phanpy and friends read off every status. */
  const REQUIRED_STATUS_FIELDS = [
    "id",
    "uri",
    "created_at",
    "content",
    "visibility",
    "sensitive",
    "spoiler_text",
    "account",
    "media_attachments",
    "mentions",
    "tags",
    "emojis",
    "reblogs_count",
    "favourites_count",
    "replies_count",
    "favourited",
    "reblogged",
    "bookmarked",
    "in_reply_to_id",
    "in_reply_to_account_id",
  ];

  const REQUIRED_ACCOUNT_FIELDS = [
    "id",
    "username",
    "acct",
    "display_name",
    "url",
    "avatar",
    "note",
  ];

  it("every status carries the full field set clients depend on", async () => {
    const res = await request(app)
      .get("/api/v1/timelines/home")
      .set("Authorization", BEARER)
      .expect(200);

    assert.ok(res.body.length > 0);

    for (const status of res.body) {
      for (const field of REQUIRED_STATUS_FIELDS) {
        assert.ok(
          field in status,
          `status ${status.id} is missing "${field}" — this breaks real clients`,
        );
      }
      for (const field of REQUIRED_ACCOUNT_FIELDS) {
        assert.ok(
          field in status.account,
          `embedded account is missing "${field}"`,
        );
      }
    }
  });

  it("status id is a 24-hex string for every status", async () => {
    const res = await request(app)
      .get("/api/v1/timelines/home")
      .set("Authorization", BEARER)
      .expect(200);

    for (const status of res.body) {
      assert.match(status.id, /^[a-f0-9]{24}$/);
    }
  });

  it(
    "CANDIDATE DEFECT — a boost wrapper's id is a content hash, not its ObjectId",
    async () => {
      const res = await request(app)
        .get("/api/v1/timelines/home")
        .set("Authorization", BEARER)
        .expect(200);

      const boost = res.body.find((s) => s.reblog);
      assert.ok(boost, "fixture seeds one boost");

      const doc = await mongo.collections.ap_timeline.findOne({ type: "boost" });

      // entities/status.js:73 — boostWrapperId = remoteActorId(`boost:${uid}:…`),
      // i.e. a sha256 prefix. Deliberate: the wrapper and the inner status must
      // have distinct ids or clients clobber each other's cache state.
      assert.notEqual(
        boost.id,
        doc._id.toString(),
        "documenting current behaviour, not endorsing it",
      );

      // The consequence: that id looks like a valid ObjectId, so
      // helpers/pagination.js parseCursor() accepts it — but its timestamp
      // prefix is a hash, not a time. A client using a boost's own id as
      // max_id paginates from an arbitrary point.
      //
      // Link headers are NOT affected: setPaginationHeaders reads the raw
      // timeline docs' _id, not the serialized status id. So this is only
      // reachable by a client that builds its own cursor from status.id.
      //
      // Not added to the register unilaterally — raise it at Stage 1 and let
      // DD-2/DD-5 decide, since both bear on cursor and identity design.
      assert.match(boost.id, /^[a-f0-9]{24}$/);
    },
  );

  it("account id is sha256(url) truncated to 24 hex chars", async () => {
    const res = await request(app)
      .get("/api/v1/timelines/home")
      .set("Authorization", BEARER)
      .expect(200);

    for (const status of res.body) {
      assert.match(status.account.id, /^[a-f0-9]{24}$/);
    }
  });

  it("emits RFC 8288 Link headers for pagination", async () => {
    const res = await request(app)
      .get("/api/v1/timelines/home?limit=3")
      .set("Authorization", BEARER)
      .expect(200);

    assert.ok(res.headers.link, "clients stop paginating without Link");
    assert.match(res.headers.link, /rel="next"/);
    assert.match(res.headers.link, /rel="prev"/);
  });

  it("max_id pagination returns strictly older items", async () => {
    const first = await request(app)
      .get("/api/v1/timelines/home?limit=3")
      .set("Authorization", BEARER)
      .expect(200);

    const cursor = first.body[first.body.length - 1].id;

    const next = await request(app)
      .get(`/api/v1/timelines/home?limit=3&max_id=${cursor}`)
      .set("Authorization", BEARER)
      .expect(200);

    const firstIds = new Set(first.body.map((s) => s.id));
    assert.ok(
      next.body.every((s) => !firstIds.has(s.id)),
      "pages must not overlap",
    );
    assert.ok(next.body.every((s) => s.id < cursor));
  });
});

describe("characterisation: Mastodon timeline behaviour", () => {
  it("home includes private, excludes direct and context (AP-D5 as-is)", async () => {
    const res = await request(app)
      .get("/api/v1/timelines/home")
      .set("Authorization", BEARER)
      .expect(200);

    const seen = new Set(res.body.map((s) => s.visibility));
    assert.ok(seen.has("private"), "current behaviour: followers-only IS shown");
    assert.ok(!seen.has("direct"));
  });

  it("sorts by _id (arrival), not published", async () => {
    const res = await request(app)
      .get("/api/v1/timelines/home")
      .set("Authorization", BEARER)
      .expect(200);

    // Boost wrappers carry a content-hash id (see the candidate defect above),
    // so they do not participate in ObjectId ordering. Compare on the underlying
    // documents instead — the query's sort is what this test is about.
    const uris = res.body.filter((s) => !s.reblog).map((s) => s.uri);

    const docs = await mongo.collections.ap_timeline
      .find({ uid: { $in: uris } })
      .sort({ _id: -1 })
      .toArray();

    assert.deepEqual(
      uris,
      docs.map((d) => d.uid),
      "the Mastodon lane must return arrival order",
    );
  });

  it("public timeline excludes replies and non-public visibilities", async () => {
    const res = await request(app).get("/api/v1/timelines/public").expect(200);

    assert.ok(res.body.every((s) => s.visibility === "public"));
    assert.ok(res.body.every((s) => !s.in_reply_to_id));
  });

  it("applies account-mute filtering to the timeline", async () => {
    const res = await request(app)
      .get("/api/v1/timelines/home")
      .set("Authorization", BEARER)
      .expect(200);

    assert.ok(
      !res.body.some((s) => s.account.url === "https://other.example/users/bob"),
      "AUTHOR_B is account-muted; ap_muted url entries DO filter the timeline — " +
        "which is why GET /api/v1/mutes returning [] is a defect, not a design",
    );
  });
});

describe("characterisation: auth surface", () => {
  it("scope-guarded endpoints reject a token without the scope", async () => {
    await mongo.collections.ap_oauth_tokens.insertOne({
      accessToken: "narrow-token",
      clientId: "test-client",
      scopes: ["read:statuses"],
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    await request(app)
      .get("/api/v1/blocks")
      .set("Authorization", "Bearer narrow-token")
      .expect(403);

    await mongo.collections.ap_oauth_tokens.deleteOne({
      accessToken: "narrow-token",
    });
  });

  it("rejects a missing or unknown bearer token with 401", async () => {
    await request(app).get("/api/v1/timelines/home").expect(401);
    await request(app)
      .get("/api/v1/timelines/home")
      .set("Authorization", "Bearer nope")
      .expect(401);
  });

  it("unmatched /api routes return 501, not 404", async () => {
    await request(app)
      .get("/api/v1/definitely-not-a-route")
      .set("Authorization", BEARER)
      .expect(501);
  });
});
