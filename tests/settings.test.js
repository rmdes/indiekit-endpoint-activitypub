/**
 * Settings merge (lib/settings.js) — getSettings merges DB over DEFAULTS with
 * safe fallbacks. Tested via a fake collections stub (no MongoDB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getSettings, DEFAULTS } from "../lib/settings.js";

const withDoc = (doc) => ({ ap_settings: { findOne: async () => doc } });

test("getSettings: no collections → a copy of DEFAULTS", async () => {
  const s = await getSettings(null);
  assert.deepEqual(s, DEFAULTS);
  assert.notEqual(s, DEFAULTS); // must be a copy, not the shared object
});

test("getSettings: no stored doc → DEFAULTS", async () => {
  assert.deepEqual(await getSettings(withDoc(null)), DEFAULTS);
});

test("getSettings: DB values override defaults, missing keys fall back", async () => {
  const s = await getSettings(withDoc({ settings: { maxCharacters: 1000, logLevel: "debug" } }));
  assert.equal(s.maxCharacters, 1000); // overridden
  assert.equal(s.logLevel, "debug"); // overridden
  assert.equal(s.replyChainDepth, DEFAULTS.replyChainDepth); // fallback
  assert.equal(s.defaultVisibility, DEFAULTS.defaultVisibility); // fallback
});

test("getSettings: supports a Map-style collections (indiekit collections.get)", async () => {
  const collections = { get: (name) => (name === "ap_settings" ? { findOne: async () => ({ settings: { parallelWorkers: 9 } }) } : null) };
  const s = await getSettings(collections);
  assert.equal(s.parallelWorkers, 9);
  assert.equal(s.maxCharacters, DEFAULTS.maxCharacters);
});

test("getSettings: findOne throwing → DEFAULTS (never throws)", async () => {
  const collections = { ap_settings: { findOne: async () => { throw new Error("db down"); } } };
  let s;
  await assert.doesNotReject(async () => { s = await getSettings(collections); });
  assert.deepEqual(s, DEFAULTS);
});

test("getSettings: result is isolated (mutating it doesn't corrupt DEFAULTS)", async () => {
  const s = await getSettings(withDoc({ settings: {} }));
  s.maxCharacters = 1;
  assert.notEqual(DEFAULTS.maxCharacters, 1);
});
