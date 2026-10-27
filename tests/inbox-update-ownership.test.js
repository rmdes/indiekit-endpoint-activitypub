/**
 * handleUpdate ownership gate (lib/inbox-handlers.js).
 *
 * Security-relevant: Fedify verifies an Update is SIGNED by its actor, but not
 * that the actor authored the object it rewrites. Without an ownership check,
 * any authenticated fediverse actor could send Update{object:<any uid>} and
 * rewrite arbitrary items in our reader timeline, including copies of our own
 * posts. The gate is the one handleDelete uses: the signing actor must share
 * the object's origin host, or have authored the stored item.
 *
 * The real Update.fromJsonLd runs against a document loader that serves fixed
 * documents, so nothing touches the network. Fedify may refetch an embedded
 * object from its own origin; the loader serves the attacker's version there
 * too, so a missing gate shows up as a rewritten item, not as a fetch error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleUpdate } from "../lib/inbox-handlers.js";

const OBJ = "https://them.example/users/x/posts/1";
const AUTHOR = "https://them.example/users/x";

const actor = (id) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id,
  type: "Person",
  preferredUsername: "someone",
  inbox: `${id}/inbox`,
});

const note = (id, attributedTo) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id,
  type: "Note",
  attributedTo,
  content: "<p>REPLACED</p>",
});

function contextFor(objectId, actorUrl) {
  const documents = {
    [objectId]: note(objectId, actorUrl),
    [AUTHOR]: actor(AUTHOR),
    [actorUrl]: actor(actorUrl),
  };
  return {
    getDocumentLoader: async () => async (url) => {
      const document = documents[url.replace(/#.*$/, "")];
      if (!document) throw new Error(`unexpected fetch of ${url}`);
      return { contextUrl: null, documentUrl: url, document };
    },
  };
}

function mockCollections(stored) {
  const calls = { updated: null };
  return {
    calls,
    ap_timeline: {
      findOne: async () => stored,
      updateOne: async (filter, update) => {
        calls.updated = { filter, update };
        return { modifiedCount: 1 };
      },
    },
  };
}

function updateItem(actorUrl) {
  return {
    activityType: "Update",
    actorUrl,
    objectUrl: OBJ,
    rawJson: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorUrl}#updates/1`,
      type: "Update",
      actor: actorUrl,
      object: {
        id: OBJ,
        type: "Note",
        attributedTo: actorUrl,
        content: "<p>REPLACED</p>",
      },
    },
  };
}

test("handleUpdate: rejects an Update from a different-host, non-author actor", async () => {
  const c = mockCollections({ uid: OBJ, author: { url: AUTHOR } });
  const attacker = "https://evil.example/users/attacker";
  await handleUpdate(updateItem(attacker), c, contextFor(OBJ, attacker), "rick");
  assert.equal(c.calls.updated, null, "timeline item must not be rewritten");
});

test("handleUpdate: allows an Update from the exact authoring actor", async () => {
  const c = mockCollections({ uid: OBJ, author: { url: AUTHOR } });
  await handleUpdate(updateItem(AUTHOR), c, contextFor(OBJ, AUTHOR), "rick");
  assert.equal(c.calls.updated?.filter.uid, OBJ);
  assert.equal(c.calls.updated.update.$set.content.html, "<p>REPLACED</p>");
});

test("handleUpdate: allows an Update from the same origin host", async () => {
  const c = mockCollections({ uid: OBJ, author: { url: AUTHOR } });
  const service = "https://them.example/actor/service";
  await handleUpdate(updateItem(service), c, contextFor(OBJ, service), "rick");
  assert.equal(c.calls.updated?.filter.uid, OBJ);
});

test("handleUpdate: protects our own posts' timeline copies", async () => {
  const ours = "https://rmendes.net/notes/2026/10/27/abc12";
  const c = mockCollections({ uid: ours, author: { url: "https://rmendes.net/" } });
  const attacker = "https://evil.example/users/attacker";
  const item = updateItem(attacker);
  item.objectUrl = ours;
  item.rawJson.object.id = ours;
  await handleUpdate(item, c, contextFor(ours, attacker), "rick");
  assert.equal(c.calls.updated, null);
});
