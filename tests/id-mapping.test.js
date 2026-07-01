/**
 * Deterministic Mastodon account IDs (lib/mastodon/helpers/id-mapping.js).
 * IDs must be stable per actor URL (collisions/instability were gotcha #36).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { remoteActorId, accountId } from "../lib/mastodon/helpers/id-mapping.js";

test("remoteActorId is deterministic and a 24-char hex string", () => {
  const a = remoteActorId("https://mastodon.social/users/alice");
  const b = remoteActorId("https://mastodon.social/users/alice");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{24}$/);
});

test("remoteActorId differs for different actor URLs", () => {
  assert.notEqual(
    remoteActorId("https://mastodon.social/users/alice"),
    remoteActorId("https://mastodon.social/users/bob"),
  );
});

test("accountId uses actor.url, then actor.actorUrl, then '0'", () => {
  const byUrl = accountId({ url: "https://x/users/a" });
  assert.equal(byUrl, remoteActorId("https://x/users/a"));

  const byActorUrl = accountId({ actorUrl: "https://x/users/a" });
  assert.equal(byActorUrl, remoteActorId("https://x/users/a"));

  assert.equal(byUrl, byActorUrl); // same URL → same id regardless of field

  assert.equal(accountId({}), "0"); // neither field present
});
