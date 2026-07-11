/**
 * Deterministic Mastodon account IDs (lib/mastodon/helpers/id-mapping.js).
 * IDs must be stable per actor URL (collisions/instability were gotcha #36).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { remoteActorId, accountId, isLocalAccountId } from "../lib/mastodon/helpers/id-mapping.js";

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

// --- isLocalAccountId ---
// Regression: the routes compared the client-held sha256(url) id against
// profile._id (Mongo ObjectId) — never equal, so /accounts/:id/followers etc.
// returned [] for EVERYONE, including the local account.

test("isLocalAccountId: matches the sha256(profile.url) id clients hold", () => {
  const profile = { _id: { toString: () => "64a1b2c3d4e5f60718293a4b" }, url: "https://rmendes.net/" };
  assert.equal(isLocalAccountId(accountId(profile), profile), true);
});

test("isLocalAccountId: legacy Mongo _id still accepted", () => {
  const profile = { _id: { toString: () => "64a1b2c3d4e5f60718293a4b" }, url: "https://rmendes.net/" };
  assert.equal(isLocalAccountId("64a1b2c3d4e5f60718293a4b", profile), true);
});

test("isLocalAccountId: a remote account id does not match", () => {
  const profile = { _id: { toString: () => "64a1b2c3d4e5f60718293a4b" }, url: "https://rmendes.net/" };
  assert.equal(isLocalAccountId(remoteActorId("https://social.coop/users/django"), profile), false);
});

test("isLocalAccountId: null profile / empty id → false", () => {
  assert.equal(isLocalAccountId("abc", null), false);
  assert.equal(isLocalAccountId("", { url: "https://x/" }), false);
});
