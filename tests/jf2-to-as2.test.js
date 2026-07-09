/**
 * Regression tests for jf2-to-as2 tag building.
 *
 * 2026-06-06: ActivityPub syndication crashed with "cat.split is not a
 * function" whenever a post's `category` array contained a non-string entry —
 * classically an IndieWeb person-tag (a nested h-card object), but also
 * null/number from malformed data. buildPlainTags / buildFedifyTags called
 * `cat.split("/")` unconditionally. Non-string categories are now skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jf2ToActivityStreams,
  jf2ToAS2Activity,
} from "../lib/jf2-to-as2.js";

const ACTOR = "https://rmendes.net/";
const PUB = "https://rmendes.net/";

function note(category) {
  return {
    type: "entry",
    "post-type": "note",
    url: "https://rmendes.net/notes/x",
    content: { html: "<p>hi</p>", text: "hi" },
    published: "2026-06-06T12:00:00.000Z",
    category,
  };
}

function hashtagNames(as2) {
  const obj = as2.object || as2;
  return (obj.tag || [])
    .filter((t) => t.type === "Hashtag")
    .map((t) => t.name);
}

test("plain string categories become hashtags", () => {
  const as2 = jf2ToActivityStreams(note(["indieweb", "devops"]), ACTOR, PUB);
  assert.deepEqual(hashtagNames(as2), ["#indieweb", "#devops"]);
});

test("person-tag h-card object in category does not crash (skipped)", () => {
  const personTag = { type: ["h-card"], properties: { name: ["Alice"], url: ["https://alice.example"] } };
  assert.doesNotThrow(() =>
    jf2ToActivityStreams(note(["indieweb", personTag]), ACTOR, PUB),
  );
  const as2 = jf2ToActivityStreams(note(["indieweb", personTag]), ACTOR, PUB);
  assert.deepEqual(hashtagNames(as2), ["#indieweb"], "h-card person-tag is not a hashtag");
});

test("null / number category entries are skipped, not crashed on", () => {
  assert.doesNotThrow(() => jf2ToActivityStreams(note(["ok", null, 42]), ACTOR, PUB));
  const as2 = jf2ToActivityStreams(note(["ok", null, 42]), ACTOR, PUB);
  assert.deepEqual(hashtagNames(as2), ["#ok"]);
});

test("whitespace in a tag is stripped from the hashtag name", () => {
  const as2 = jf2ToActivityStreams(note(["dev ops"]), ACTOR, PUB);
  assert.deepEqual(hashtagNames(as2), ["#devops"]);
});

test("jf2ToAS2Activity (Fedify path) also survives non-string categories", () => {
  const personTag = { type: ["h-card"], properties: { name: ["Bob"] } };
  assert.doesNotThrow(() =>
    jf2ToAS2Activity(note(["indieweb", personTag, null]), ACTOR, PUB),
  );
});

test("jf2ToAS2Activity: Note carries attributedTo (Fedify prop is `attribution`)", async () => {
  const create = jf2ToAS2Activity(note([]), ACTOR, PUB);
  const json = await create.toJsonLd({ format: "compact" });
  // Regression for R3-1: passing `attributedTo` to new Note() is silently
  // dropped by Fedify (it wants `attribution`), which shipped author-less Notes.
  assert.equal(json.object.attributedTo, ACTOR, "Note must attribute the author");
});

test("jf2ToAS2Activity: Create wrapper mirrors the object's addressing + published", async () => {
  const create = jf2ToAS2Activity(note([]), ACTOR, PUB);
  const json = await create.toJsonLd({ format: "compact" });
  // Regression for R3-5: AS2 activities don't inherit their object's to/cc.
  assert.equal(json.to, "as:Public", "Create carries to");
  assert.ok(String(json.cc || "").includes("/followers"), "Create carries cc:followers");
  assert.ok(json.published, "Create carries published");
});
