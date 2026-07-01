/**
 * Mastodon Client API response sanitization (lib/mastodon/entities/sanitize.js).
 * XSS prevention on JSON API content served to Phanpy/Elk/Moshidon etc.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeHtml, stripHtml } from "../lib/mastodon/entities/sanitize.js";

// --- sanitizeHtml ---

test("sanitizeHtml keeps allowed inline markup + links", () => {
  const out = sanitizeHtml('<p>hi <strong>x</strong> <a href="https://ok.example" rel="me">y</a></p>');
  assert.ok(out.includes("<strong>x</strong>"));
  assert.ok(out.includes('href="https://ok.example"'));
});

test("sanitizeHtml strips disallowed tags (script, img, div)", () => {
  const out = sanitizeHtml('<div><script>alert(1)</script><img src="x">ok</div>');
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("alert(1)"));
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("<div"));
  assert.ok(out.includes("ok"));
});

test("sanitizeHtml strips javascript: hrefs, keeps http(s)", () => {
  assert.ok(!sanitizeHtml('<a href="javascript:alert(1)">x</a>').includes("javascript:"));
  assert.ok(sanitizeHtml('<a href="https://ok.example">x</a>').includes('href="https://ok.example"'));
});

test("sanitizeHtml returns empty string for non-string/empty input", () => {
  assert.equal(sanitizeHtml(""), "");
  assert.equal(sanitizeHtml(null), "");
  assert.equal(sanitizeHtml(42), "");
});

// --- stripHtml ---

test("stripHtml removes all tags and trims", () => {
  assert.equal(stripHtml("  <p>hello <b>world</b></p>  "), "hello world");
});

test("stripHtml returns empty string for non-string/empty input", () => {
  assert.equal(stripHtml(""), "");
  assert.equal(stripHtml(null), "");
});
