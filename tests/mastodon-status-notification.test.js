/**
 * Mastodon Status + Notification serializers (the complex ones).
 * lib/mastodon/entities/status.js + notification.js. Pure given input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeStatus, setLocalIdentity } from "../lib/mastodon/entities/status.js";
import { serializeNotification } from "../lib/mastodon/entities/notification.js";

const oid = (s) => ({ toString: () => s });

// --- serializeStatus ---

test("serializeStatus: null item → null", () => {
  assert.equal(serializeStatus(null, { baseUrl: "https://x" }), null);
});

test("serializeStatus: id from _id.toString(); content + default visibility", () => {
  const s = serializeStatus(
    { _id: oid("abc"), uid: "u1", content: { html: "<p>hi</p>" }, author: { url: "https://remote/x" } },
    { baseUrl: "https://x" },
  );
  assert.equal(s.id, "abc");
  assert.equal(s.content, "<p>hi</p>");
  assert.equal(s.visibility, "public");
});

test("serializeStatus: interaction flags come from the provided Sets (by uid)", () => {
  const item = { _id: oid("a"), uid: "u9", content: { text: "x" }, author: { url: "https://remote/y" } };
  const s = serializeStatus(item, {
    baseUrl: "https://x",
    favouritedIds: new Set(["u9"]),
    bookmarkedIds: new Set(["u9"]),
    rebloggedIds: new Set(),
  });
  assert.equal(s.favourited, true);
  assert.equal(s.bookmarked, true);
  assert.equal(s.reblogged, false);
});

test("serializeStatus: boost reconstructs a nested reblog with the booster as account", () => {
  const item = {
    _id: oid("b"), uid: "boost1", type: "boost",
    boostedBy: { url: "https://remote/booster", name: "Booster" },
    content: { html: "<p>original</p>" }, author: { url: "https://remote/author" },
  };
  const s = serializeStatus(item, { baseUrl: "https://x", rebloggedIds: new Set(["boost1"]) });
  assert.equal(s.content, ""); // outer boost has empty content
  assert.equal(s.reblogged, true);
  assert.ok(s.reblog, "nested reblog present");
  assert.equal(s.reblog.content, "<p>original</p>");
  assert.equal(s.account.url, "https://remote/booster"); // account = booster
});

test("serializeStatus: photo/video/audio become typed media_attachments", () => {
  const s = serializeStatus(
    {
      _id: oid("m"), uid: "u", content: { text: "x" }, author: { url: "https://remote/z" },
      photo: [{ url: "https://m/p.jpg", alt: "pic" }], video: ["https://m/v.mp4"], audio: ["https://m/a.mp3"],
    },
    { baseUrl: "https://x" },
  );
  const types = s.media_attachments.map((a) => a.type);
  assert.deepEqual(types, ["image", "video", "audio"]);
  assert.equal(s.media_attachments[0].description, "pic");
});

test("serializeStatus: tags built from category[]", () => {
  const s = serializeStatus(
    { _id: oid("t"), uid: "u", content: { text: "x" }, author: { url: "https://remote/z" }, category: ["indieweb"] },
    { baseUrl: "https://x" },
  );
  assert.deepEqual(s.tags, [{ name: "indieweb", url: "https://x/tags/indieweb" }]);
});

test("serializeStatus: own-post permalink appended when author matches local identity", () => {
  setLocalIdentity("https://me.example/", "me");
  const s = serializeStatus(
    { _id: oid("own"), uid: "https://me.example/notes/1", url: "https://me.example/notes/1",
      content: { html: "<p>mine</p>" }, author: { url: "https://me.example/" } },
    { baseUrl: "https://me.example" },
  );
  assert.ok(s.content.includes("https://me.example/notes/1"), "permalink appended");
  assert.ok(s.content.includes("\u{1F517}"), "link emoji appended");
  setLocalIdentity(undefined, undefined); // reset module state for other tests
});

// --- serializeNotification ---

test("serializeNotification: null → null", () => {
  assert.equal(serializeNotification(null, { baseUrl: "https://x" }), null);
});

test("serializeNotification: maps internal types to Mastodon types", () => {
  const mk = (type) => serializeNotification({ _id: oid("n"), type, actorUrl: "https://remote/a" }, { baseUrl: "https://x" });
  assert.equal(mk("like").type, "favourite");
  assert.equal(mk("boost").type, "reblog");
  assert.equal(mk("follow").type, "follow");
  assert.equal(mk("dm").type, "mention");
  assert.equal(mk("weird").type, "weird"); // unknown passes through
});

test("serializeNotification: builds account from actor fields; created_at from Date → ISO", () => {
  const n = serializeNotification(
    { _id: oid("n2"), type: "follow", actorName: "Alice", actorUrl: "https://remote/alice", actorHandle: "@alice@mas.to",
      published: new Date("2026-03-02T00:00:00.000Z") },
    { baseUrl: "https://x" },
  );
  assert.equal(n.account.acct, "alice@mas.to");
  assert.equal(n.created_at, "2026-03-02T00:00:00.000Z");
  assert.equal(n.status, null); // no statusMap / content
});

test("serializeNotification: mention with content but no statusMap → minimal status (dm → direct)", () => {
  const n = serializeNotification(
    { _id: oid("n3"), type: "dm", actorUrl: "https://remote/b", content: { html: "<p>hey</p>" }, uid: "u3" },
    { baseUrl: "https://x" },
  );
  assert.ok(n.status, "minimal status constructed");
  assert.equal(n.status.visibility, "direct");
  assert.equal(n.status.content, "<p>hey</p>");
});
