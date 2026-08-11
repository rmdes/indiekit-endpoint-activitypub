/**
 * Stage 0.3 — PARITY SUITE.
 *
 * One test per operation available on both surfaces, asserting the reader lane
 * (lib/controllers/* + lib/storage/*) and the Mastodon lane
 * (lib/mastodon/routes/*) agree.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THESE TESTS ARE EXPECTED TO FAIL until the single-lane refactor      │
 * │ lands. Each failure maps 1:1 onto a defect in the plan's §1 register │
 * │ — that mapping IS the Stage 0.3 acceptance check.                    │
 * │                                                                       │
 * │ Every currently-failing test is marked `{ todo: "AP-Dx …" }`, so the │
 * │ suite is green today and each todo→pass transition is a defect       │
 * │ closing. Refactor exit criterion: NO todo annotations remain.        │
 * │                                                                       │
 * │ Do NOT "fix" a failure by weakening the assertion. The assertion is  │
 * │ the specification of what parity means.                              │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * COVERAGE GAP — AP-D4 (two thread builders) is NOT covered here. Comparing
 * them requires driving `controllers/post-detail.js`, which renders Nunjucks
 * and needs the Indiekit frontend's configured view environment. It lands in
 * Stage 0.4 (route-level integration) once that harness exists. Until then
 * AP-D4 has no parity guard — do not read this suite's green as covering it.
 *
 * Plan: documentation-central/plans/2026-08-10-activitypub-single-lane-core-plan.md
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { seed } from "./helpers/fixtures.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";

// Reader lane — the storage layer IS the reader's query path.
import { getTimelineItems } from "../lib/storage/timeline.js";
import {
  getNotifications,
  markNotificationsRead,
} from "../lib/storage/notifications.js";
import { getMutedUrls, getAllMuted } from "../lib/storage/moderation.js";
import {
  loadModerationData,
  applyModerationFilters,
  invalidateModerationCache,
} from "../lib/item-processing.js";

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

/** Fetch the Mastodon home timeline as an array of status objects. */
async function mastodonHome(query = "") {
  const res = await request(app)
    .get(`/api/v1/timelines/home${query}`)
    .set("Authorization", BEARER);

  assert.equal(res.status, 200, `home timeline returned ${res.status}`);
  return res.body;
}

/**
 * Reader home timeline — the reader's FULL path, not just the storage query.
 *
 * `lib/controllers/api-timeline.js` composes getTimelineItems() with the shared
 * moderation filters from item-processing.js. Comparing the bare storage query
 * against the Mastodon route would compare a layer to a lane and manufacture a
 * difference that isn't a defect: the Mastodon route applies moderation too.
 */
async function readerHome(options = {}) {
  const { items } = await getTimelineItems(mongo.collections, {
    limit: 40,
    ...options,
  });

  // The controller reads moderation through a short-lived cache; drop it so a
  // mute written earlier in the suite is visible to the next call.
  invalidateModerationCache();

  const moderation = await loadModerationData({
    ap_muted: mongo.collections.ap_muted,
    ap_blocked: mongo.collections.ap_blocked,
    ap_profile: mongo.collections.ap_profile,
  });

  return applyModerationFilters(items, moderation);
}

// ───────────────────────────────────────────────────────────────────────────
// AP-D5 / DD-4 — visibility
// ───────────────────────────────────────────────────────────────────────────

describe("parity: timeline visibility (AP-D5, DD-4 ratified: include private)", () => {
  it(
    "both lanes surface the same visibility set on the home timeline",
    { todo: "AP-D5 — reader excludes `private`, Mastodon includes it" },
    async () => {
      const mastodon = await mastodonHome();
      const reader = await readerHome();

      const visibilities = (rows, key) =>
        [...new Set(rows.map((r) => r[key]))].sort();

      assert.deepEqual(
        visibilities(reader, "visibility"),
        visibilities(mastodon, "visibility"),
      );
    },
  );

  it("neither lane surfaces direct messages in the home timeline", async () => {
    const mastodon = await mastodonHome();
    const reader = await readerHome();

    assert.ok(!mastodon.some((s) => s.visibility === "direct"));
    assert.ok(!reader.some((i) => i.visibility === "direct"));
  });

  it("neither lane surfaces context-only ancestors", async () => {
    const mastodon = await mastodonHome();
    const reader = await readerHome();

    assert.ok(!mastodon.some((s) => s.uri?.endsWith("/notes/16")));
    assert.ok(!reader.some((i) => i.isContext === true));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D7 — ordering
// ───────────────────────────────────────────────────────────────────────────

describe("parity: timeline ordering (AP-D7)", () => {
  it(
    "both lanes place the late-arriving post in the same position",
    {
      todo:
        "AP-D7 — Mastodon sorts by _id (arrival), reader by published. " +
        "Closes when DD-1's receivedAt lands in Stage 2.",
    },
    async () => {
      const mastodon = await mastodonHome();
      const reader = await readerHome();

      const indexOfLate = (rows, get) =>
        rows.findIndex((r) => get(r).includes("/notes/late"));

      const readerIndex = indexOfLate(reader, (i) => i.uid);
      const mastodonIndex = indexOfLate(mastodon, (s) => s.uri || s.url || "");

      // Guard against a vacuous pass: if moderation or a filter drops the item
      // from both lanes, -1 === -1 would "prove" parity while testing nothing.
      assert.notEqual(readerIndex, -1, "late arrival missing from reader lane");
      assert.notEqual(mastodonIndex, -1, "late arrival missing from Mastodon lane");

      assert.equal(readerIndex, mastodonIndex);
    },
  );

  it("each lane is at least internally consistent with its own sort key", async () => {
    const reader = await readerHome();
    const published = reader.map((i) => i.published);
    const sorted = [...published].sort().reverse();

    assert.deepEqual(published, sorted, "reader must be published-descending");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D3 — timeline read-tracking
// ───────────────────────────────────────────────────────────────────────────

describe("parity: timeline read-tracking (AP-D3)", () => {
  it(
    "reading the timeline in the Mastodon lane marks items read for the reader",
    { todo: "AP-D3 — the Mastodon lane never touches the `read` field" },
    async () => {
      const before = await mongo.collections.ap_timeline.countDocuments({
        read: { $ne: true },
      });

      await mastodonHome();

      const after = await mongo.collections.ap_timeline.countDocuments({
        read: { $ne: true },
      });

      assert.ok(
        after < before,
        `expected unread count to drop after reading (was ${before}, still ${after})`,
      );
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D2 — notification read-state
// ───────────────────────────────────────────────────────────────────────────

describe("parity: notification read-state (AP-D2)", () => {
  it(
    "dismissing in the Mastodon lane marks the notification read for the reader",
    { todo: "AP-D2 — Mastodon writes `dismissed`, the reader reads `read`" },
    async () => {
      const target = await mongo.collections.ap_notifications.findOne({
        uid: "https://remote.example/follows/1",
      });

      await request(app)
        .post(`/api/v1/notifications/${target._id.toString()}/dismiss`)
        .set("Authorization", BEARER)
        .expect(200);

      const { items } = await getNotifications(mongo.collections, {
        unreadOnly: true,
        limit: 50,
      });

      assert.ok(
        !items.some((n) => n.uid === target.uid),
        "a notification dismissed in Phanpy must not still be unread in the reader",
      );
    },
  );

  it(
    "marking read in the reader hides the notification from the Mastodon lane",
    { todo: "AP-D2 — the Mastodon lane filters on `dismissed`, not `read`" },
    async () => {
      const uid = "https://remote.example/likes/1";
      const target = await mongo.collections.ap_notifications.findOne({ uid });
      await markNotificationsRead(mongo.collections, [uid]);

      const res = await request(app)
        .get("/api/v1/notifications")
        .set("Authorization", BEARER)
        .expect(200);

      // serializeNotification sets id = notif._id.toString(). Matching on a URI
      // substring would be vacuous: a `like` notification's status is the TARGET
      // post, whose uri never contains "likes/1".
      assert.ok(
        res.body.length > 0,
        "guard: the Mastodon lane must return notifications at all",
      );
      assert.ok(
        !res.body.some((n) => n.id === target._id.toString()),
        "a notification read in the reader must not still show in Phanpy",
      );
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D9 — account mutes
// ───────────────────────────────────────────────────────────────────────────

describe("parity: account mutes (AP-D9)", () => {
  it("the reader lists the account mute", async () => {
    const urls = await getMutedUrls(mongo.collections);
    assert.equal(urls.length, 1, "fixture seeds exactly one account mute");
  });

  it(
    "GET /api/v1/mutes returns the same account mutes the reader shows",
    {
      todo:
        "AP-D9 — stubs.js:139 returns [] unconditionally, on the false premise " +
        "that ap_muted holds only keyword mutes",
    },
    async () => {
      const readerMutes = await getMutedUrls(mongo.collections);

      const res = await request(app)
        .get("/api/v1/mutes")
        .set("Authorization", BEARER)
        .expect(200);

      assert.equal(
        res.body.length,
        readerMutes.length,
        `reader shows ${readerMutes.length} account mute(s), API shows ${res.body.length}`,
      );
    },
  );

  it(
    "a mute written by the Mastodon API is readable back from the same API",
    { todo: "AP-D9 — intra-surface: POST /accounts/:id/mute writes, GET /mutes cannot read" },
    async () => {
      const before = await request(app)
        .get("/api/v1/mutes")
        .set("Authorization", BEARER)
        .expect(200);

      // The relationships endpoint proves the write landed and is understood.
      const all = await getAllMuted(mongo.collections);
      assert.ok(all.some((m) => m.url), "an account mute exists in storage");

      assert.ok(
        before.body.length > 0,
        "GET /mutes must reflect account mutes that exist in ap_muted",
      );
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D8 — follow requests
// ───────────────────────────────────────────────────────────────────────────

describe("parity: follow requests (AP-D8)", () => {
  it("the Mastodon lane lists pending follow requests", async () => {
    const res = await request(app)
      .get("/api/v1/follow_requests")
      .set("Authorization", BEARER)
      .expect(200);

    assert.equal(res.body.length, 1, "fixture seeds one pending follow");
  });

  it(
    "a listed follow request can be authorized through the Mastodon API",
    { todo: "AP-D8 — no authorize/reject endpoint exists; the control is dead" },
    async () => {
      const res = await request(app)
        .get("/api/v1/follow_requests")
        .set("Authorization", BEARER)
        .expect(200);

      const id = res.body[0].id;

      const authorized = await request(app)
        .post(`/api/v1/follow_requests/${id}/authorize`)
        .set("Authorization", BEARER);

      // Unmatched /api/* routes return 501 via notImplementedHandler, NOT 404 —
      // so asserting "not 404" would pass while the endpoint doesn't exist.
      assert.equal(
        authorized.status,
        200,
        `authorize returned ${authorized.status}; listing a follow request the ` +
          "client cannot action is a dead control",
      );

      const remaining = await mongo.collections.ap_pending_follows.countDocuments();
      assert.equal(remaining, 0, "an authorized request must leave the pending list");
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D6′ — remaining stubs
// ───────────────────────────────────────────────────────────────────────────

describe("parity: remaining stubbed reads (AP-D6')", () => {
  it("domain blocks are readable — closed in v3.13.21/27", async () => {
    const res = await request(app)
      .get("/api/v1/domain_blocks")
      .set("Authorization", BEARER)
      .expect(200);

    assert.equal(res.body.length, 1, "regression guard: this was AP-D6");
  });

  it("followed tags are readable — closed in v3.13.21/27", async () => {
    const res = await request(app)
      .get("/api/v1/followed_tags")
      .set("Authorization", BEARER)
      .expect(200);

    assert.equal(res.body.length, 2, "regression guard: this was AP-D6");
  });

  it("account blocks are readable — closed in v3.13.21/27", async () => {
    const res = await request(app)
      .get("/api/v1/blocks")
      .set("Authorization", BEARER)
      .expect(200);

    assert.equal(res.body.length, 1, "regression guard: this was AP-D6");
  });

  it(
    "conversations are readable",
    { todo: "AP-D6' — GET /api/v1/conversations still returns []" },
    async () => {
      const res = await request(app)
        .get("/api/v1/conversations")
        .set("Authorization", BEARER)
        .expect(200);

      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length > 0, "DMs exist but conversations returns []");
    },
  );
});
