/**
 * Import-graph smoke test.
 *
 * Stage 5 deleted functions that lib/controllers/{reader,tag-timeline}.js still
 * imported. The full 231-test suite passed anyway, because no test imported
 * those two modules — the break only surfaced when index.js was loaded by hand
 * on the way to a release.
 *
 * ESM import errors are load-time, not call-time: one stale named import takes
 * the whole plugin down at boot, and a green unit suite says nothing about it.
 * These tests import every module the plugin ships, so a dangling import fails
 * here instead of in production.
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function* walk(dir) {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(rel);
    else if (entry.name.endsWith(".js")) yield rel;
  }
}

describe("import graph", () => {
  it("index.js loads — every transitive import resolves", async () => {
    const module = await import("../index.js");
    assert.equal(typeof module.default, "function", "plugin class must export");
  });

  it("every module under lib/ imports cleanly", async () => {
    const failures = [];

    for await (const file of walk("lib")) {
      try {
        await import(join(ROOT, file));
      } catch (error) {
        failures.push(`${file}: ${error.message}`);
      }
    }

    assert.deepEqual(failures, [], `modules failed to import:\n${failures.join("\n")}`);
  });

  it("no module still imports a function core replaced", async () => {
    // Cheap belt-and-braces: these names were deleted in Stage 5. A new import
    // of one would already fail above, but naming them makes the reason obvious
    // rather than leaving a maintainer to decode an ESM error.
    const removed = [
      "getTimelineItems",
      "countNewItems",
      "markItemsRead",
      "countUnreadItems",
      "markNotificationsRead",
      "markAllNotificationsRead",
      "clearAllNotifications",
      "getNotificationCountsByType",
      "getUnreadNotificationCount",
    ];

    const storage = await Promise.all([
      import("../lib/storage/timeline.js"),
      import("../lib/storage/notifications.js"),
    ]);

    for (const name of removed) {
      for (const module of storage) {
        assert.equal(
          module[name],
          undefined,
          `${name} was deleted in Stage 5 — core owns it now`,
        );
      }
    }
  });
});
