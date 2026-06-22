import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITYPUB_BLOCKS } from "../lib/blocks.js";

// Phase 7b — activitypub v2 `get blocks()`. Assertions replicate the invariants
// of site-config's `validBlockEntry` (lib/discovery/block-entry.js); the canonical
// validator lives in site-config (not a dependency here), so we encode it.

const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REGIONS = new Set(["main", "sidebar", "footer", "hero"]);
const SURFACES = new Set(["homepage", "collection", "postType", "standalone"]);
const DATA_SOURCES = new Set(["file", "collections", "config", "api"]);

test("ACTIVITYPUB_BLOCKS: exactly the fediverse-follow widget", () => {
  assert.deepEqual(ACTIVITYPUB_BLOCKS.map((b) => b.id), ["fediverse-follow"]);
});

test("ACTIVITYPUB_BLOCKS: every entry satisfies the v2 block contract", () => {
  for (const b of ACTIVITYPUB_BLOCKS) {
    assert.ok(KEBAB_ID.test(b.id), `${b.id}: id kebab`);
    assert.ok(Number.isInteger(b.version) && b.version >= 1, `${b.id}: version >= 1`);
    assert.ok(typeof b.label === "string" && b.label.length > 0, `${b.id}: label`);
    assert.ok(Array.isArray(b.placement.regions) && b.placement.regions.length > 0, `${b.id}: regions`);
    assert.ok(b.placement.regions.every((r) => REGIONS.has(r)), `${b.id}: regions vocab`);
    assert.ok(Array.isArray(b.placement.surfaces), `${b.id}: surfaces array`);
    assert.ok(b.placement.surfaces.every((s) => SURFACES.has(s)), `${b.id}: surfaces vocab`);
    assert.ok(DATA_SOURCES.has(b.data.source), `${b.id}: data.source`);
    assert.equal(typeof b.multiple, "boolean", `${b.id}: multiple boolean`);
    assert.equal(b.schema.type, "object", `${b.id}: schema.type`);
    assert.equal(b.schema.additionalProperties, false, `${b.id}: additionalProperties false`);
    assert.ok(b.schema.properties && typeof b.schema.properties === "object", `${b.id}: properties`);
    assert.ok(!("required" in b.schema), `${b.id}: NO required`);
  }
});

test("ACTIVITYPUB_BLOCKS: fediverse-follow is a config-less homepage sidebar widget, config-sourced, bespoke", () => {
  const [b] = ACTIVITYPUB_BLOCKS;
  assert.deepEqual([...b.placement.regions], ["sidebar"]);
  assert.deepEqual([...b.placement.surfaces], ["homepage"]);
  assert.deepEqual(b.data, { source: "config" });
  assert.deepEqual(b.schema.properties, {});
  assert.equal(b.defaultConfig, undefined);
  assert.equal(b.multiple, false);
  assert.ok(!b.render, "bespoke — theme owns widgets/fediverse-follow.njk");
});
