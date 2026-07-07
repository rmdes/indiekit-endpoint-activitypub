/**
 * handleDelete ownership gate (lib/inbox-handlers.js).
 *
 * Security-relevant: Fedify verifies a Delete is SIGNED by its actor, but not
 * that the actor authored the target object. Without an ownership check, any
 * authenticated fediverse actor could send Delete{object:<any uid>} and purge
 * arbitrary items from our reader timeline. The gate honours the Delete only
 * when the signing actor shares the object's origin host, or authored the item.
 * handleDelete(item, collections) takes plain values, so we test it with a
 * mock collections object — no federation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleDelete } from "../lib/inbox-handlers.js";

const OBJ = "https://them.example/users/x/posts/1";
const AUTHOR = "https://them.example/users/x";

function mockCollections(stored) {
  const calls = { timelineDeleted: false, activitiesDeleted: false };
  return {
    calls,
    ap_timeline: {
      findOne: async () => stored,
      deleteOne: async () => {
        calls.timelineDeleted = true;
        return { deletedCount: 1 };
      },
    },
    ap_activities: {
      deleteMany: async () => {
        calls.activitiesDeleted = true;
        return { deletedCount: 0 };
      },
    },
  };
}

test("handleDelete: rejects a Delete from a different-host, non-author actor", async () => {
  const c = mockCollections({ uid: OBJ, author: { url: AUTHOR } });
  await handleDelete(
    { objectUrl: OBJ, actorUrl: "https://evil.example/users/attacker" },
    c,
  );
  assert.equal(c.calls.timelineDeleted, false, "timeline item must survive");
  assert.equal(c.calls.activitiesDeleted, false, "activity log untouched on rejection");
});

test("handleDelete: allows a Delete from the same origin host (e.g. service actor)", async () => {
  const c = mockCollections({ uid: OBJ, author: { url: AUTHOR } });
  await handleDelete(
    { objectUrl: OBJ, actorUrl: "https://them.example/actor/service" },
    c,
  );
  assert.equal(c.calls.timelineDeleted, true);
  assert.equal(c.calls.activitiesDeleted, true);
});

test("handleDelete: allows a Delete from the exact authoring actor", async () => {
  const c = mockCollections({ uid: OBJ, author: { url: AUTHOR } });
  await handleDelete({ objectUrl: OBJ, actorUrl: AUTHOR }, c);
  assert.equal(c.calls.timelineDeleted, true);
});

test("handleDelete: item not in timeline → nothing to spoof, cleanup proceeds", async () => {
  const c = mockCollections(null);
  await handleDelete(
    { objectUrl: OBJ, actorUrl: "https://evil.example/users/attacker" },
    c,
  );
  assert.equal(c.calls.activitiesDeleted, true);
});

test("handleDelete: no objectUrl → no-op", async () => {
  const c = mockCollections({ uid: OBJ, author: { url: AUTHOR } });
  await handleDelete({ objectUrl: "", actorUrl: AUTHOR }, c);
  assert.equal(c.calls.timelineDeleted, false);
  assert.equal(c.calls.activitiesDeleted, false);
});
