/**
 * Inbound content security (lib/timeline-store.js).
 *
 * sanitizeContent is the XSS chokepoint for ALL inbound timeline/notification
 * HTML from untrusted remote servers. replaceCustomEmoji (now the single
 * canonical implementation — the unhardened emoji-utils.js copy was removed in
 * 3.13.10) validates emoji URL schemes and escapes attributes. Both pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeContent, replaceCustomEmoji } from "../lib/timeline-store.js";

// --- sanitizeContent (XSS prevention) ---

test("sanitizeContent: empty/falsy → empty string", () => {
  assert.equal(sanitizeContent(""), "");
  assert.equal(sanitizeContent(null), "");
  assert.equal(sanitizeContent(undefined), "");
});

test("sanitizeContent: keeps allowed formatting tags + attributes", () => {
  const out = sanitizeContent('<p>hi <strong>there</strong> <a href="https://ok.example" rel="me" class="u-url">link</a></p>');
  assert.ok(out.includes("<strong>there</strong>"));
  assert.ok(out.includes('href="https://ok.example"'));
  assert.ok(out.includes('rel="me"'));
});

test("sanitizeContent: strips <script> and its content", () => {
  const out = sanitizeContent('<p>ok</p><script>alert(1)</script>');
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("alert(1)"));
  assert.ok(out.includes("<p>ok</p>"));
});

test("sanitizeContent: strips <iframe> and inline event handlers", () => {
  assert.ok(!sanitizeContent('<iframe src="https://evil.example"></iframe>').includes("<iframe"));
  const out = sanitizeContent('<p onclick="steal()">x</p>');
  assert.ok(!out.includes("onclick"));
  assert.ok(out.includes("x"));
});

test("sanitizeContent: strips javascript: href and data: img src", () => {
  assert.ok(!sanitizeContent('<a href="javascript:alert(1)">x</a>').includes("javascript:"));
  assert.ok(!sanitizeContent('<img src="data:image/png;base64,AAAA">').includes("data:"));
});

test("sanitizeContent: keeps http(s) img src", () => {
  assert.ok(sanitizeContent('<img src="https://cdn.example/a.png" alt="a">').includes('src="https://cdn.example/a.png"'));
});

// --- replaceCustomEmoji (hardened variant in timeline-store) ---

test("replaceCustomEmoji: replaces :shortcode: with an http(s) img", () => {
  const out = replaceCustomEmoji(":blob:", [{ shortcode: "blob", url: "https://e.example/blob.png" }]);
  assert.ok(out.includes('src="https://e.example/blob.png"'));
  assert.ok(out.includes("ap-custom-emoji"));
});

test("replaceCustomEmoji: REJECTS javascript:/data: emoji URLs (leaves shortcode literal)", () => {
  const jsOut = replaceCustomEmoji(":x:", [{ shortcode: "x", url: "javascript:alert(1)" }]);
  assert.equal(jsOut, ":x:"); // skipped, not rendered
  const dataOut = replaceCustomEmoji(":x:", [{ shortcode: "x", url: "data:text/html,evil" }]);
  assert.equal(dataOut, ":x:");
});

test("replaceCustomEmoji: HTML-escapes the URL to prevent attribute injection", () => {
  const out = replaceCustomEmoji(":x:", [{ shortcode: "x", url: 'https://e.example/a.png"onerror="alert(1)' }]);
  assert.ok(!out.includes('"onerror="'), "quote must be escaped");
  assert.ok(out.includes("&quot;"));
});

test("replaceCustomEmoji: no emojis or no html → passthrough", () => {
  assert.equal(replaceCustomEmoji(":x:", []), ":x:");
  assert.equal(replaceCustomEmoji("", [{ shortcode: "a", url: "https://e/x.png" }]), "");
});
