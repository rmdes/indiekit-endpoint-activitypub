/**
 * Micropub lifecycle hooks on the ActivityPub syndicator — regression guard.
 *
 * @rmdes/indiekit-endpoint-micropub's postContent.delete calls an optional
 * `delete(url)` on every syndication target. This hook is how a deletion from
 * the Indiekit admin, a Micropub client or the Mastodon API reaches the
 * plugin's delete hook (FEP-4f05 Tombstone + Delete to followers). The
 * Mastodon API route relies on it and deliberately does NOT federate again
 * after a successful Micropub delete, so losing this hook would silently stop
 * deletes from federating on every path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSyndicator } from "../lib/syndicator.js";

function pluginDouble() {
  const deleted = [];
  return {
    deleted,
    plugin: {
      options: { checked: true, actor: { handle: "rick" } },
      _publicationUrl: "https://local.example/",
      async delete(url) {
        deleted.push(url);
      },
    },
  };
}

describe("AP syndicator Micropub hooks", () => {
  it("delete(url) federates through the plugin's delete hook", async () => {
    const { plugin, deleted } = pluginDouble();
    const syndicator = createSyndicator(plugin);

    assert.equal(typeof syndicator.delete, "function", "Micropub looks for s.delete");
    await syndicator.delete("https://local.example/notes/1");

    assert.deepEqual(deleted, ["https://local.example/notes/1"]);
  });
});
