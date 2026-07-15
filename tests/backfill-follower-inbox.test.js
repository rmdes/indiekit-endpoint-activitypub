/**
 * backfillFollowerInbox repairs followers stored with no deliverable address
 * (the legacy `actor.inbox?.id?.href` accessor bug). It must:
 *  - target only followers with BOTH inbox and sharedInbox empty (the ones that
 *    actually miss broadcasts; sharedInbox-having followers still deliver),
 *  - populate inbox from the live actor's `inboxId.href`,
 *  - be a no-op when nothing is broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillFollowerInbox } from "../lib/migrations/backfill-follower-inbox.js";

function fakeFollowers(docs) {
  const store = docs.map((d) => ({ ...d }));
  return {
    all: () => store,
    find() {
      // Mirror the both-empty query intent.
      const matched = store.filter((d) => !d.inbox && !d.sharedInbox);
      return {
        project: () => ({
          toArray: async () => matched.map((d) => ({ actorUrl: d.actorUrl })),
        }),
      };
    },
    async updateOne(filter, update) {
      const doc = store.find((d) => d.actorUrl === filter.actorUrl);
      if (doc) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    },
  };
}

// Fake federation whose ctx.lookupObject returns a vocab-shaped actor with an
// inboxId. The REAL lookupWithSecurity runs against this fake ctx.
const fakeFederation = {
  createContext() {
    return {
      async getDocumentLoader() {
        return {};
      },
      async lookupObject(url) {
        if (url === "https://robida.net/ap/actor") {
          return { inboxId: { href: "https://robida.net/ap/actor/inbox" } };
        }
        return null; // unresolvable
      },
    };
  },
};

const deps = (collections) => ({
  federation: fakeFederation,
  collections,
  handle: "rick",
  publicationUrl: "https://rmendes.net/",
});

test("populates inbox for a both-empty follower from the live actor", async () => {
  const followers = fakeFollowers([
    { actorUrl: "https://robida.net/ap/actor", inbox: "", sharedInbox: "" },
    // has a sharedInbox → not in the query set → left untouched
    { actorUrl: "https://mastodon.social/users/x", inbox: "", sharedInbox: "https://mastodon.social/inbox" },
  ]);

  const result = await backfillFollowerInbox(deps({ ap_followers: followers }));

  assert.equal(result.updated, 1);
  assert.equal(result.attempted, 1);
  const robida = followers.all().find((d) => d.actorUrl.includes("robida"));
  assert.equal(robida.inbox, "https://robida.net/ap/actor/inbox");
  const masto = followers.all().find((d) => d.actorUrl.includes("mastodon"));
  assert.equal(masto.inbox, "", "sharedInbox-having follower untouched");
});

test("no-op when no follower is both-empty", async () => {
  const followers = fakeFollowers([
    { actorUrl: "https://x/a", inbox: "https://x/a/inbox", sharedInbox: "" },
  ]);
  const result = await backfillFollowerInbox(deps({ ap_followers: followers }));
  assert.equal(result.updated, 0);
});

test("skips gracefully without federation", async () => {
  const result = await backfillFollowerInbox({
    federation: null,
    collections: { ap_followers: fakeFollowers([]) },
    handle: "r",
    publicationUrl: "https://rmendes.net/",
  });
  assert.equal(result.skipped, true);
});
