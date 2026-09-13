/**
 * Outbound direct messages carry an author.
 *
 * Fedify vocab constructors take `attribution`, not the JSON-LD name
 * `attributedTo` — the wrong key is silently dropped (gotcha #41, fixed in
 * jf2-to-as2.js in July). The reader's DM path still used `attributedTo`, so
 * every DM sent from the reader went out as a Note with no attributedTo.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Temporal } from "@js-temporal/polyfill";

import { buildDirectMessage } from "../lib/controllers/messages.js";

describe("buildDirectMessage", () => {
  const actorUri = new URL("https://local.example/activitypub/users/rick");
  const recipient = {
    id: new URL("https://remote.example/users/alice"),
    preferredUsername: "alice",
  };

  const { note, create } = buildDirectMessage({
    actorUri,
    recipient,
    noteId: "https://local.example/activitypub/messages/1",
    htmlContent: "<p>hi</p>",
    replyTo: "",
    now: Temporal.Now.instant(),
  });

  it("the Note is attributed to our actor", () => {
    assert.equal(note.attributionId?.href, actorUri.href);
  });

  it("the Create is from our actor, addressed only to the recipient", () => {
    assert.equal(create.actorId?.href, actorUri.href);
    assert.deepEqual(create.toIds.map((u) => u.href), [recipient.id.href]);
    assert.deepEqual(note.toIds.map((u) => u.href), [recipient.id.href]);
  });
});
