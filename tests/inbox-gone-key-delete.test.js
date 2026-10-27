/**
 * handleGoneKeyDelete (lib/inbox-handlers.js), the onUnverifiedActivity hook.
 *
 * Security-relevant: when an account is deleted its key URL returns 404/410,
 * so the farewell Delete cannot be verified and Fedify hands it to this hook
 * unauthenticated. Anyone can produce that situation (sign with a key URL that
 * 404s), so the hook must not trust the Delete itself. It purges an actor's
 * data only for a Delete of the actor itself, signed with a key on the actor's
 * own origin, and only once fetching the actor ourselves returns 404/410.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Create, Delete, Note } from "@fedify/vocab";

import { handleGoneKeyDelete } from "../lib/inbox-handlers.js";

const VICTIM = "https://them.example/users/x";

const gone = (status) => () => {
  throw Object.assign(new Error(`HTTP ${status}`), {
    response: new Response(null, { status }),
  });
};

function mockCollections() {
  const calls = { purged: [] };
  const record = (name) => async (filter) => {
    calls.purged.push(name);
    return { deletedCount: 1, filter };
  };
  return {
    calls,
    ap_followers: { deleteOne: record("followers") },
    ap_timeline: { deleteMany: record("timeline") },
    ap_notifications: { deleteMany: record("notifications") },
  };
}

function contextFor(load) {
  const fetched = [];
  return {
    fetched,
    documentLoader: async (url) => {
      fetched.push(url);
      return load(url);
    },
  };
}

const keyGone = (keyId, status = 410) => ({
  type: "keyFetchError",
  keyId: new URL(keyId),
  result: { status },
});

const accountDelete = (actor = VICTIM) =>
  new Delete({
    id: new URL(`${actor}#delete`),
    actor: new URL(actor),
    object: new URL(actor),
  });

test("purges a deleted account's data once the actor is confirmed gone", async () => {
  const c = mockCollections();
  const ctx = contextFor(gone(410));
  const response = await handleGoneKeyDelete(
    ctx,
    accountDelete(),
    keyGone(`${VICTIM}#main-key`),
    c,
  );

  assert.equal(response?.status, 202);
  assert.deepEqual(ctx.fetched, [VICTIM]);
  assert.deepEqual(c.calls.purged.sort(), ["followers", "notifications", "timeline"]);
});

test("keeps the data when the actor still exists", async () => {
  const c = mockCollections();
  const ctx = contextFor((url) => ({ contextUrl: null, documentUrl: url, document: {} }));
  const response = await handleGoneKeyDelete(
    ctx,
    accountDelete(),
    keyGone(`${VICTIM}/nonexistent#key`, 404),
    c,
  );

  assert.equal(response, null);
  assert.deepEqual(c.calls.purged, []);
});

test("keeps the data when the actor cannot be fetched for another reason", async () => {
  const c = mockCollections();
  const ctx = contextFor(() => {
    throw new Error("Timed out");
  });
  const response = await handleGoneKeyDelete(
    ctx,
    accountDelete(),
    keyGone(`${VICTIM}#main-key`),
    c,
  );

  assert.equal(response, null);
  assert.deepEqual(c.calls.purged, []);
});

test("ignores a key on another origin, without fetching anything", async () => {
  const c = mockCollections();
  const ctx = contextFor(gone(410));
  const response = await handleGoneKeyDelete(
    ctx,
    accountDelete(),
    keyGone("https://evil.example/gone#key"),
    c,
  );

  assert.equal(response, null);
  assert.deepEqual(ctx.fetched, []);
  assert.deepEqual(c.calls.purged, []);
});

test("ignores a Delete of anything other than the actor itself", async () => {
  const c = mockCollections();
  const ctx = contextFor(gone(410));
  const activity = new Delete({
    id: new URL(`${VICTIM}#delete`),
    actor: new URL(VICTIM),
    object: new URL(`${VICTIM}/posts/1`),
  });
  const response = await handleGoneKeyDelete(
    ctx,
    activity,
    keyGone(`${VICTIM}#main-key`),
    c,
  );

  assert.equal(response, null);
  assert.deepEqual(c.calls.purged, []);
});

test("ignores other activities and other failure reasons", async () => {
  const c = mockCollections();
  const ctx = contextFor(gone(410));
  const create = new Create({
    id: new URL(`${VICTIM}#create`),
    actor: new URL(VICTIM),
    object: new Note({ id: new URL(`${VICTIM}/posts/1`) }),
  });

  assert.equal(
    await handleGoneKeyDelete(ctx, create, keyGone(`${VICTIM}#main-key`), c),
    null,
  );
  assert.equal(
    await handleGoneKeyDelete(ctx, accountDelete(), { type: "invalidSignature" }, c),
    null,
  );
  assert.equal(
    await handleGoneKeyDelete(ctx, accountDelete(), keyGone(`${VICTIM}#main-key`, 500), c),
    null,
  );
  assert.deepEqual(c.calls.purged, []);
});
