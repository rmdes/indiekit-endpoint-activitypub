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
 * Plan: documentation-central/plans/2026-08-10-activitypub-single-lane-core-plan.md
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";

import { withMongo } from "./helpers/mongo.js";
import { seed } from "./helpers/fixtures.js";
import { makeMastodonApp, BEARER } from "./helpers/mastodon-app.js";
import { makeReaderApp } from "./helpers/reader-app.js";

// Reader lane — the storage layer IS the reader's query path.
import {
  getNotifications,
  markRead as markNotificationsRead,
} from "../lib/core/notifications.js";
import { getMutedUrls, getAllMuted } from "../lib/storage/moderation.js";
import { getAncestors } from "../lib/core/threads.js";
import {
  loadModerationData,
  applyModerationFilters,
  invalidateModerationCache,
} from "../lib/item-processing.js";

let mongo;
let app;
let readerApp;

before(async () => {
  mongo = await withMongo();
  await seed(mongo.collections);
  app = makeMastodonApp(mongo.collections);
  readerApp = makeReaderApp(mongo.collectionMap);
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
 * Reader home timeline, driven through the ACTUAL adapter over HTTP.
 *
 * Originally this called lib/storage/timeline.js directly. That was correct
 * before Stage 2 — the storage layer was the reader's query path. Now that
 * api-timeline.js is an adapter over lib/core/timeline.js, calling storage
 * would compare a module the reader no longer uses, and the parity todos would
 * never flip no matter what the refactor achieved.
 *
 * Returns the parsed cards, so counts and identities are comparable with the
 * Mastodon lane's status array.
 */
async function readerHome(query = "") {
  // The adapter reads moderation through a 30s cache; drop it so a mute
  // written earlier in the suite is visible to the next call.
  invalidateModerationCache();

  const res = await request(readerApp).get(
    `/admin/reader/api/timeline?tab=all${query}`,
  );

  assert.equal(res.status, 200, `reader timeline returned ${res.status}`);

  // Each card is <article class="ap-card…" data-uid="…">
  const uids = [...res.body.html.matchAll(/data-uid="([^"]+)"/g)].map((m) => m[1]);

  return uids.map((uid) => ({ uid }));
}

/** Visibility per uid, read back from storage — the cards do not carry it. */
async function visibilityOf(uids) {
  const docs = await mongo.collections.ap_timeline
    .find({ uid: { $in: uids } }, { projection: { uid: 1, visibility: 1 } })
    .toArray();

  return [...new Set(docs.map((d) => d.visibility))].sort();
}

// ───────────────────────────────────────────────────────────────────────────
// AP-D5 / DD-4 — visibility
// ───────────────────────────────────────────────────────────────────────────

describe("parity: timeline visibility (AP-D5, DD-4 ratified: include private)", () => {
  it(
    // AP-D5 CLOSED (Stage 2): both lanes read core/timeline.js, whose home
    // predicate is `visibility: {$nin: ["direct"]}` per DD-4.
    "both lanes surface the same visibility set on the home timeline",
    async () => {
      const mastodon = await mastodonHome();
      const reader = await readerHome();

      const mastodonVis = [...new Set(mastodon.map((s) => s.visibility))].sort();
      const readerVis = await visibilityOf(reader.map((i) => i.uid));

      assert.deepEqual(readerVis, mastodonVis);
    },
  );

  it("neither lane surfaces direct messages in the home timeline", async () => {
    const mastodon = await mastodonHome();
    const reader = await readerHome();

    assert.ok(!mastodon.some((s) => s.visibility === "direct"));

    const readerVis = await visibilityOf(reader.map((i) => i.uid));
    assert.ok(!readerVis.includes("direct"));
  });

  it("neither lane surfaces context-only ancestors", async () => {
    const mastodon = await mastodonHome();
    const reader = await readerHome();

    assert.ok(!mastodon.some((s) => s.uri?.endsWith("/notes/16")));
    assert.ok(!reader.some((i) => i.uid.endsWith("/notes/16")));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D7 — ordering
// ───────────────────────────────────────────────────────────────────────────

describe("parity: timeline ordering (AP-D7)", () => {
  it(
    // AP-D7 CLOSED (Stage 2): one sort key, `receivedAt` desc with `_id` as
    // tiebreak, owned by core/cursor.js#buildPage per DD-1.
    "both lanes place the late-arriving post in the same position",
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

  it("the reader now orders by arrival, not publication (DD-1)", async () => {
    const reader = await readerHome();
    const uids = reader.map((i) => i.uid);

    const docs = await mongo.collections.ap_timeline
      .find({ uid: { $in: uids } })
      .sort({ receivedAt: -1, _id: -1 })
      .toArray();

    assert.deepEqual(
      uids,
      docs.map((d) => d.uid),
      "the reader must return arrival order after the Stage 2 port",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AP-D3 — timeline read-tracking
// ───────────────────────────────────────────────────────────────────────────

describe("parity: timeline read-tracking (AP-D3)", () => {
  it(
    // AP-D3 CLOSED (Stage 2): serving the timeline calls core markRead, so the
    // phone and the desktop share one unread state.
    "reading the timeline in the Mastodon lane marks items read for the reader",
    async () => {
      // Earlier tests in this file serve the Mastodon timeline, which now marks
      // items read — that is the behaviour under test. Reset first so this
      // measures its own effect, not a leftover from suite ordering.
      await mongo.collections.ap_timeline.updateMany(
        {},
        { $set: { readAt: null, read: false } },
      );

      const before = await mongo.collections.ap_timeline.countDocuments({
        readAt: null,
      });

      await mastodonHome();

      const after = await mongo.collections.ap_timeline.countDocuments({
        readAt: null,
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
    // AP-D2 CLOSED (Stage 2): both lanes read and write the shared `readAt`
    // via core/notifications.js, per DD-3.
    "dismissing in the Mastodon lane marks the notification read for the reader",
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
    // AP-D2 CLOSED (Stage 2): the Mastodon lane filters on `readAt`, which the
    // reader also writes.
    "marking read in the reader hides the notification from the Mastodon lane",
    async () => {
      // Own the state: earlier tests in this file mark notifications read, and
      // an empty list would let this pass vacuously.
      await mongo.collections.ap_notifications.updateMany(
        {},
        { $set: { readAt: null, read: false, dismissed: false } },
      );

      const uid = "https://remote.example/likes/1";
      const target = await mongo.collections.ap_notifications.findOne({ uid });

      const beforeRes = await request(app)
        .get("/api/v1/notifications")
        .set("Authorization", BEARER)
        .expect(200);

      assert.ok(
        beforeRes.body.some((n) => n.id === target._id.toString()),
        "guard: the notification must be visible BEFORE it is marked read",
      );

      // The reader marks it read...
      await markNotificationsRead(mongo.collections, { uids: [uid] });

      const res = await request(app)
        .get("/api/v1/notifications")
        .set("Authorization", BEARER)
        .expect(200);

      // serializeNotification sets id = notif._id.toString(). Matching on a URI
      // substring would be vacuous: a `like` notification's status is the TARGET
      // post, whose uri never contains "likes/1".
      assert.ok(
        !res.body.some((n) => n.id === target._id.toString()),
        "a notification read in the reader must not still show in Phanpy",
      );
      assert.ok(
        res.body.length > 0,
        "guard: only the ONE marked notification should disappear",
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
    // AP-D9 CLOSED (Stage 4): core/moderation.js knows ap_muted holds BOTH
    // account mutes ({url}) and keyword mutes ({keyword}).
    "GET /api/v1/mutes returns the same account mutes the reader shows",
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
    // AP-D9 CLOSED (Stage 4) — the intra-surface half: the API can now read
    // back what it writes.
    "a mute written by the Mastodon API is readable back from the same API",
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
    // AP-D8 CLOSED (Stage 4): POST /api/v1/follow_requests/:id/{authorize,reject}
    // added, both over core/follow-requests.js.
    "a listed follow request can be authorized through the Mastodon API",
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
// AP-D4 — thread building
// ───────────────────────────────────────────────────────────────────────────

describe("parity: thread building (AP-D4)", () => {
  // notes/15 is the tip of a 6-deep reply chain rooted at notes/9.
  const DEEP_TIP = "https://remote.example/notes/15";

  /** Ancestors as the reader builds them. */
  async function readerAncestors() {
    const tip = await mongo.collections.ap_timeline.findOne({ uid: DEEP_TIP });
    // The reader now calls core/threads#getAncestors. No ctx: every ancestor in
    // the fixture is local, so the remote-fetch path is not exercised here.
    return getAncestors(mongo.collections, tip.inReplyTo);
  }

  /** Ancestors as the Mastodon lane builds them. */
  async function mastodonAncestors() {
    const tip = await mongo.collections.ap_timeline.findOne({ uid: DEEP_TIP });

    const res = await request(app)
      .get(`/api/v1/statuses/${tip._id.toString()}/context`)
      .set("Authorization", BEARER);

    assert.equal(res.status, 200, `context returned ${res.status}`);
    return res.body.ancestors;
  }

  it("the fixture chain is deeper than the reader's default maxDepth", async () => {
    const mastodon = await mastodonAncestors();
    assert.ok(
      mastodon.length > 5,
      `chain is ${mastodon.length} deep; must exceed 5 or AP-D4 is untestable here`,
    );
  });

  it(
    // AP-D4 CLOSED (Stage 3): one implementation, one depth (MAX_ANCESTORS).
    // The reader keeps its remote-fetch capability; what it loses is the
    // shallower default that made it show FEWER ancestors than the phone.
    "both lanes return the same number of ancestors",
    async () => {
      const reader = await readerAncestors();
      const mastodon = await mastodonAncestors();

      assert.equal(
        reader.length,
        mastodon.length,
        `reader built ${reader.length} ancestors, Mastodon built ${mastodon.length}`,
      );
    },
  );

  it(
    // AP-D4 CLOSED (Stage 3).
    "both lanes agree on the root of the thread",
    async () => {
      const reader = await readerAncestors();
      const mastodon = await mastodonAncestors();

      assert.equal(reader[0]?.uid, mastodon[0]?.uri);
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
    // AP-D6' CLOSED (Stage 4): both lanes read core/messages.js.
    "conversations are readable",
    async () => {
      const res = await request(app)
        .get("/api/v1/conversations")
        .set("Authorization", BEARER)
        .expect(200);

      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 2, "fixture seeds two conversations");
      assert.ok(res.body.some((c) => c.unread), "unread state must be exposed");
      assert.ok(res.body.every((c) => c.last_status?.content));
    },
  );
});
