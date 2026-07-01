/**
 * Mastodon entity serializers (lib/mastodon/entities/{relationship,media,account}.js).
 * Pure transforms from internal state → Mastodon Client API JSON.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeRelationship } from "../lib/mastodon/entities/relationship.js";
import { serializeMediaAttachment } from "../lib/mastodon/entities/media.js";
import { serializeAccount } from "../lib/mastodon/entities/account.js";

// --- serializeRelationship ---

test("serializeRelationship defaults every flag to false", () => {
  const r = serializeRelationship("42");
  assert.equal(r.id, "42");
  assert.equal(r.following, false);
  assert.equal(r.showing_reblogs, false);
  assert.equal(r.blocking, false);
  assert.equal(r.note, "");
});

test("serializeRelationship: following implies showing_reblogs; state maps through", () => {
  const r = serializeRelationship("42", { following: true, followed_by: true, muting: true, requested: true });
  assert.equal(r.following, true);
  assert.equal(r.showing_reblogs, true);
  assert.equal(r.followed_by, true);
  assert.equal(r.muting, true);
  assert.equal(r.muting_notifications, true);
  assert.equal(r.requested, true);
});

// --- serializeMediaAttachment ---

test("serializeMediaAttachment detects type from contentType", () => {
  assert.equal(serializeMediaAttachment({ contentType: "image/png" }).type, "image");
  assert.equal(serializeMediaAttachment({ contentType: "video/mp4" }).type, "video");
  assert.equal(serializeMediaAttachment({ contentType: "audio/mpeg" }).type, "audio");
  assert.equal(serializeMediaAttachment({ contentType: "application/pdf" }).type, "unknown");
});

test("serializeMediaAttachment: image/gif resolves to 'image' (gifv branch is unreachable — latent)", () => {
  // detectMediaType checks 'image/' before 'image/gif', so gifv is never returned.
  assert.equal(serializeMediaAttachment({ contentType: "image/gif" }).type, "image");
});

test("serializeMediaAttachment: id from _id.toString(), url/description fallbacks", () => {
  const m = serializeMediaAttachment({
    _id: { toString: () => "abc123" },
    url: "https://m.example/1.png",
    alt: "a cat",
  });
  assert.equal(m.id, "abc123");
  assert.equal(m.preview_url, "https://m.example/1.png"); // falls back to url
  assert.equal(m.description, "a cat"); // falls back from description → alt
});

// --- serializeAccount ---

test("serializeAccount returns null for a null actor", () => {
  assert.equal(serializeAccount(null, { baseUrl: "https://x" }), null);
});

test("serializeAccount: local account uses bare handle for username + acct", () => {
  const a = serializeAccount(
    { url: "https://rmendes.net/", name: "Rick" },
    { baseUrl: "https://rmendes.net", isLocal: true, handle: "rick" },
  );
  assert.equal(a.username, "rick");
  assert.equal(a.acct, "rick"); // local = bare
  assert.equal(a.display_name, "Rick");
  assert.equal(a.bot, false);
  assert.equal(a.avatar, "https://rmendes.net/images/default-avatar.svg"); // default fallback
});

test("serializeAccount: remote @user@domain handle → user + user@domain", () => {
  const a = serializeAccount(
    { handle: "@alice@mas.to", name: "Alice", url: "https://mas.to/@alice" },
    { baseUrl: "https://rmendes.net", isLocal: false },
  );
  assert.equal(a.username, "alice");
  assert.equal(a.acct, "alice@mas.to");
});

test("serializeAccount: Service/Application actorType → bot; Group → group", () => {
  assert.equal(serializeAccount({ url: "https://x/", actorType: "Service" }, { baseUrl: "https://x" }).bot, true);
  assert.equal(serializeAccount({ url: "https://x/", actorType: "Group" }, { baseUrl: "https://x" }).group, true);
});

test("serializeAccount sanitizes note and field values (XSS)", () => {
  const a = serializeAccount(
    {
      url: "https://x/",
      summary: "hi <script>alert(1)</script>",
      attachments: [{ name: "site", value: '<b>ok</b><script>evil()</script>' }],
    },
    { baseUrl: "https://x" },
  );
  assert.ok(!a.note.includes("<script"));
  assert.ok(!a.note.includes("alert(1)"));
  assert.ok(!a.fields[0].value.includes("<script"));
  assert.ok(a.fields[0].value.includes("<b>ok</b>"));
});
