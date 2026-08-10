/**
 * AP-D1 regression tests — boost/unboost delivery targets.
 *
 * The defect: the admin reader carried its own unboost implementation that
 * delivered Undo(Announce) to followers ONLY, never to the original post
 * author — so a boost undone from the reader stayed counted on the origin
 * server forever. The shared helper always delivered to both; the reader kept
 * a stale copy of the pre-fix logic.
 *
 * The assertion that matters is `sentToAuthor` on unboost. A version of these
 * tests that only checks follower delivery would pass against the broken code,
 * because follower delivery was never the bug.
 *
 * No network: the Fedify context double resolves the author locally via
 * lookupObject, which is the single seam every resolveAuthor strategy uses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boostPost,
  unboostPost,
  likePost,
  unlikePost,
} from "../lib/mastodon/helpers/interactions.js";

const TARGET = "https://remote.example/users/alice/statuses/1";
const AUTHOR = "https://remote.example/users/alice";
const ACTOR = "https://local.example/activitypub/users/rick";

/**
 * Fedify context double.
 *
 * Records every sendActivity call, and resolves the post URL to an author
 * actor through lookupObject — the seam all three resolveAuthor strategies
 * funnel through (via lookupWithSecurity).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.resolvable=true] - When false, lookupObject returns
 *   null, simulating an unreachable origin server.
 */
function makeFederation({ resolvable = true } = {}) {
  const sent = [];
  const authorActor = { id: new URL(AUTHOR) };

  const ctx = {
    sendActivity(sender, recipient, activity, options) {
      sent.push({ recipient, activity, options });
    },
    getActorUri: () => new URL(ACTOR),
    getFollowersUri: () => new URL(`${ACTOR}/followers`),
    getDocumentLoader: async () => ({}),
    async lookupObject(input) {
      if (!resolvable) return null;

      const url = input instanceof URL ? input.href : String(input);

      // The post itself → an object whose attributedTo is the author.
      if (url === TARGET) {
        return { getAttributedTo: async () => authorActor };
      }

      // The author actor, however it was arrived at.
      if (url === AUTHOR) return authorActor;

      return null;
    },
  };

  return { federation: { createContext: () => ctx }, sent, authorActor };
}

/** In-memory stand-in for the ap_interactions collection. */
function makeInteractions(seed = []) {
  const docs = [...seed];
  const match = (d, q) => d.objectUrl === q.objectUrl && d.type === q.type;

  return {
    docs,
    async findOne(query) {
      return docs.find((d) => match(d, query)) || null;
    },
    async updateOne(query, update, options) {
      const index = docs.findIndex((d) => match(d, query));
      if (index >= 0) {
        docs[index] = { ...docs[index], ...update.$set };
      } else if (options?.upsert) {
        docs.push({ ...update.$set });
      }
    },
    async deleteOne(query) {
      const index = docs.findIndex((d) => match(d, query));
      if (index >= 0) docs.splice(index, 1);
    },
  };
}

function args(federation, interactions) {
  return {
    targetUrl: TARGET,
    federation,
    handle: "rick",
    publicationUrl: "https://local.example/",
    collections: new Map(),
    interactions,
    loadRsaKey: async () => null,
  };
}

/** Was anything addressed to the "followers" collection? */
const sentToFollowers = (sent) => sent.some((s) => s.recipient === "followers");

/** Was anything addressed directly to the resolved author actor? */
const sentToAuthor = (sent) =>
  sent.some((s) => s.recipient?.id?.href === AUTHOR);

describe("AP-D1 — boost delivers to followers AND the original author", () => {
  it("boost reaches both", async () => {
    const { federation, sent } = makeFederation();
    await boostPost(args(federation, makeInteractions()));

    assert.ok(sentToFollowers(sent), "Announce must reach followers");
    assert.ok(sentToAuthor(sent), "Announce must reach the original author");
  });

  it("boost records the interaction", async () => {
    const { federation } = makeFederation();
    const interactions = makeInteractions();
    await boostPost(args(federation, interactions));

    assert.equal(interactions.docs.length, 1);
    assert.equal(interactions.docs[0].type, "boost");
    assert.equal(interactions.docs[0].objectUrl, TARGET);
  });
});

describe("AP-D1 — unboost delivers to followers AND the original author", () => {
  const seeded = () =>
    makeInteractions([
      { objectUrl: TARGET, type: "boost", activityId: `${ACTOR}/boosts/x` },
    ]);

  it("unboost reaches followers", async () => {
    const { federation, sent } = makeFederation();
    await unboostPost(args(federation, seeded()));

    assert.ok(sentToFollowers(sent), "Undo(Announce) must reach followers");
  });

  it("unboost reaches the original author — THE regression guard", async () => {
    const { federation, sent } = makeFederation();
    await unboostPost(args(federation, seeded()));

    assert.ok(
      sentToAuthor(sent),
      "Undo(Announce) must reach the original author, or the origin server " +
        "never decrements its boost count (AP-D1)",
    );
  });

  it("unboost removes the local interaction record", async () => {
    const { federation } = makeFederation();
    const interactions = seeded();
    await unboostPost(args(federation, interactions));

    assert.equal(interactions.docs.length, 0);
  });

  it("reports undone:false and delivers nothing when there was no boost", async () => {
    const { federation, sent } = makeFederation();
    const result = await unboostPost(args(federation, makeInteractions()));

    assert.equal(result.undone, false);
    assert.equal(sent.length, 0);
  });

  it("still removes the record when the author is unreachable", async () => {
    const { federation, sent } = makeFederation({ resolvable: false });
    const interactions = seeded();

    const result = await unboostPost(args(federation, interactions));

    assert.equal(result.undone, true);
    assert.equal(interactions.docs.length, 0, "local state must not be stuck");
    assert.ok(sentToFollowers(sent), "followers delivery is unaffected");
    assert.ok(!sentToAuthor(sent));
  });
});

describe("AP-D1 — like/unlike delivery", () => {
  it("like delivers to the author and reports delivered:true", async () => {
    const { federation, sent } = makeFederation();
    const result = await likePost(args(federation, makeInteractions()));

    assert.equal(result.delivered, true);
    assert.ok(sentToAuthor(sent), "Like must reach the author");
    assert.ok(result.activityId.startsWith("https://local.example/"));
  });

  it("like reports delivered:false when the author is unreachable, but records locally", async () => {
    const { federation, sent } = makeFederation({ resolvable: false });
    const interactions = makeInteractions();

    const result = await likePost(args(federation, interactions));

    assert.equal(result.delivered, false);
    assert.equal(sent.length, 0);
    assert.equal(interactions.docs.length, 1, "local record still written");
  });

  it("unlike delivers Undo(Like) to the author", async () => {
    const { federation, sent } = makeFederation();
    const interactions = makeInteractions([
      { objectUrl: TARGET, type: "like", activityId: `${ACTOR}/likes/x` },
    ]);

    const result = await unlikePost(args(federation, interactions));

    assert.equal(result.undone, true);
    assert.ok(sentToAuthor(sent), "Undo(Like) must reach the author");
    assert.equal(interactions.docs.length, 0);
  });

  it("reports undone:false when there was no like", async () => {
    const { federation, sent } = makeFederation();
    const result = await unlikePost(args(federation, makeInteractions()));

    assert.equal(result.undone, false);
    assert.equal(sent.length, 0);
  });
});
