/**
 * Stage 0.1 acceptance — the harness seeds and tears down cleanly.
 *
 * Also asserts the properties later suites depend on, so a fixture edit that
 * quietly removes a defect's evidence fails here rather than making a parity
 * test silently pass.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { seed, TIMELINE } from "./helpers/fixtures.js";

describe("Stage 0.1 — fixture harness", () => {
  let mongo;

  before(async () => {
    mongo = await withMongo();
    await seed(mongo.collections);
  });

  after(async () => {
    await mongo?.stop();
  });

  it("seeds every fixture collection", async () => {
    const counts = {
      ap_timeline: await mongo.collections.ap_timeline.countDocuments(),
      ap_notifications: await mongo.collections.ap_notifications.countDocuments(),
      ap_interactions: await mongo.collections.ap_interactions.countDocuments(),
      ap_muted: await mongo.collections.ap_muted.countDocuments(),
      ap_blocked_servers: await mongo.collections.ap_blocked_servers.countDocuments(),
      ap_followed_tags: await mongo.collections.ap_followed_tags.countDocuments(),
      ap_pending_follows: await mongo.collections.ap_pending_follows.countDocuments(),
    };

    assert.equal(counts.ap_timeline, TIMELINE.length);
    assert.equal(counts.ap_notifications, 4);
    assert.equal(counts.ap_interactions, 3);
    assert.equal(counts.ap_muted, 2);
    assert.equal(counts.ap_blocked_servers, 1);
    assert.equal(counts.ap_followed_tags, 2);
    assert.equal(counts.ap_pending_follows, 1);
  });

  it("exposes both collection shapes over the same data", async () => {
    const viaObject = await mongo.collections.ap_timeline.countDocuments();
    const viaMap = await mongo.collectionMap.get("ap_timeline").countDocuments();

    assert.equal(viaObject, viaMap);
  });

  describe("the dataset actually contains each defect's evidence", () => {
    it("AP-D9 — ap_muted holds an account mute AND a keyword mute", async () => {
      const byUrl = await mongo.collections.ap_muted.countDocuments({
        url: { $exists: true },
      });
      const byKeyword = await mongo.collections.ap_muted.countDocuments({
        keyword: { $exists: true },
      });

      assert.equal(byUrl, 1, "an account mute must be present");
      assert.equal(byKeyword, 1, "a keyword mute must be present");
    });

    it("AP-D2 — notifications carry both read and dismissed states", async () => {
      const read = await mongo.collections.ap_notifications.countDocuments({
        read: true,
      });
      const dismissed = await mongo.collections.ap_notifications.countDocuments({
        dismissed: true,
      });

      assert.equal(read, 1);
      assert.equal(dismissed, 1);
    });

    it("AP-D5 — one item per visibility value", async () => {
      for (const visibility of ["public", "unlisted", "private", "direct"]) {
        const n = await mongo.collections.ap_timeline.countDocuments({ visibility });
        assert.ok(n >= 1, `expected at least one ${visibility} item`);
      }
    });

    it("AP-D7 — published order and insertion order genuinely disagree", async () => {
      const byPublished = await mongo.collections.ap_timeline
        .find({})
        .sort({ published: -1 })
        .limit(1)
        .toArray();

      const byId = await mongo.collections.ap_timeline
        .find({})
        .sort({ _id: -1 })
        .limit(1)
        .toArray();

      assert.notEqual(
        byPublished[0].uid,
        byId[0].uid,
        "the late-arrival fixture must make the two orderings differ, " +
          "or AP-D7 parity tests prove nothing",
      );
      assert.equal(byId[0].uid, "https://remote.example/notes/late");
    });

    it("AP-D4 — a reply chain deeper than the reader's maxDepth of 5", async () => {
      let depth = 0;
      let current = await mongo.collections.ap_timeline.findOne({
        uid: "https://remote.example/notes/15",
      });

      while (current?.inReplyTo) {
        depth += 1;
        current = await mongo.collections.ap_timeline.findOne({
          uid: current.inReplyTo,
        });
      }

      assert.ok(depth > 5, `chain depth ${depth} must exceed maxDepth=5`);
    });

    it("legacy empty-string inReplyTo is present", async () => {
      const n = await mongo.collections.ap_timeline.countDocuments({
        inReplyTo: "",
      });
      assert.equal(n, 1);
    });

    it("a context-only ancestor is present", async () => {
      const n = await mongo.collections.ap_timeline.countDocuments({
        isContext: true,
      });
      assert.equal(n, 1);
    });
  });

  it("reset() empties the database and leaves it reusable", async () => {
    await mongo.reset();
    assert.equal(await mongo.collections.ap_timeline.countDocuments(), 0);

    await seed(mongo.collections);
    assert.equal(
      await mongo.collections.ap_timeline.countDocuments(),
      TIMELINE.length,
    );
  });
});
