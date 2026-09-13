/**
 * Reader post detail — replies come from core/threads#getDescendants (AP-D4).
 *
 * The reader used its own direct-replies-only query while Mastodon /context
 * returned direct AND nested replies, so the same conversation showed fewer
 * replies on desktop. Local descendants are now core's; the reader still adds
 * the object's remote replies collection on top.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { loadReplies } from "../lib/controllers/post-detail.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.reset();
});

const ROOT = "https://remote.example/notes/root";
const row = (n, inReplyTo, published) => ({
  uid: `https://remote.example/notes/${n}`,
  url: `https://remote.example/notes/${n}`,
  type: "note",
  inReplyTo,
  published,
});

describe("loadReplies", () => {
  it("includes nested local replies, oldest first, like Mastodon /context", async () => {
    await mongo.collections.ap_timeline.insertMany([
      row("direct", ROOT, "2026-08-01T10:00:00.000Z"),
      row("nested", "https://remote.example/notes/direct", "2026-08-01T11:00:00.000Z"),
      row("unrelated", "https://remote.example/notes/other", "2026-08-01T09:00:00.000Z"),
    ]);

    // Fedify object double with no remote replies collection.
    const object = { id: new URL(ROOT), getReplies: async () => null };
    const replies = await loadReplies(object, null, null, mongo.collections);

    assert.deepEqual(
      replies.map((r) => r.uid),
      ["https://remote.example/notes/direct", "https://remote.example/notes/nested"],
    );
  });
});
