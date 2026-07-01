/**
 * Config defaults + admin navigation (lib/defaults.js, lib/navigation.js) —
 * extracted from the index.js god-entry in the Phase 2 refactor, now unit-tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, resolveOptions } from "../lib/defaults.js";
import { buildNavigationItems } from "../lib/navigation.js";

// --- resolveOptions ---

test("resolveOptions with no args returns the defaults (mountPath, actor.handle)", () => {
  const o = resolveOptions();
  assert.equal(o.mountPath, "/activitypub");
  assert.equal(o.actor.handle, "rick");
  assert.equal(o.actorType, "Person");
});

test("resolveOptions overrides top-level keys, keeps the rest as defaults", () => {
  const o = resolveOptions({ mountPath: "/ap", parallelWorkers: 9 });
  assert.equal(o.mountPath, "/ap");
  assert.equal(o.parallelWorkers, 9);
  assert.equal(o.timelineRetention, DEFAULTS.timelineRetention); // fallback
});

test("resolveOptions deep-merges the nested actor object", () => {
  const o = resolveOptions({ actor: { name: "Ricardo" } });
  assert.equal(o.actor.name, "Ricardo"); // overridden
  assert.equal(o.actor.handle, "rick"); // default preserved (not wiped by shallow merge)
});

test("resolveOptions does not mutate DEFAULTS", () => {
  const o = resolveOptions({ mountPath: "/x" });
  o.actor.handle = "changed";
  assert.equal(DEFAULTS.actor.handle, "rick");
});

// --- buildNavigationItems ---

test("buildNavigationItems returns 8 db-gated items prefixed with the mount path", () => {
  const items = buildNavigationItems("/ap");
  assert.equal(items.length, 8);
  assert.ok(items.every((i) => i.requiresDatabase === true));
  assert.equal(items[0].href, "/ap"); // dashboard root
  assert.ok(items.every((i) => i.href.startsWith("/ap")));
});

test("buildNavigationItems includes the settings + reader entries", () => {
  const hrefs = buildNavigationItems("/activitypub").map((i) => i.href);
  assert.ok(hrefs.includes("/activitypub/admin/settings"));
  assert.ok(hrefs.includes("/activitypub/admin/reader"));
});
