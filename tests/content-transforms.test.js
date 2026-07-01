/**
 * Pure content post-processing helpers (content-utils.js). Pure string transforms.
 * (Custom-emoji rendering is covered in timeline-sanitize.test.js against the
 * single hardened replaceCustomEmoji in timeline-store.js.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { shortenDisplayUrls, collapseHashtagStuffing } from "../lib/content-utils.js";

// --- shortenDisplayUrls ---

test("shortenDisplayUrls: leaves short link text untouched", () => {
  const html = '<a href="https://a.co/b">https://a.co/b</a>';
  assert.equal(shortenDisplayUrls(html), html);
});

test("shortenDisplayUrls: truncates long link text, strips protocol, adds title", () => {
  const url = "https://example.com/really/long/path/segment/here";
  const out = shortenDisplayUrls(`<a href="${url}">${url}</a>`);
  assert.ok(out.includes(`title="${url}"`), "adds full-URL title");
  assert.ok(out.includes("example.com/really/long/path/…"), "protocol stripped + ellipsis");
  assert.ok(!out.includes("segment/here</a>"), "visible text truncated");
});

test("shortenDisplayUrls: null/empty passthrough", () => {
  assert.equal(shortenDisplayUrls(""), "");
  assert.equal(shortenDisplayUrls(null), null);
});

// --- collapseHashtagStuffing ---

test("collapseHashtagStuffing: wraps a hashtag-only paragraph in <details>", () => {
  const html = '<p><a href="/a">#alpha</a> <a href="/b">#beta</a> <a href="/c">#gamma</a></p>';
  const out = collapseHashtagStuffing(html);
  assert.ok(out.includes("<details"), "collapsed");
  assert.ok(out.includes("Show 3 tags"));
});

test("collapseHashtagStuffing: leaves paragraphs below the tag threshold alone", () => {
  const html = '<p><a href="/a">#alpha</a> <a href="/b">#beta</a></p>'; // only 2
  assert.equal(collapseHashtagStuffing(html), html);
});

test("collapseHashtagStuffing: leaves prose-heavy paragraphs alone even with 3 tags", () => {
  const html =
    "<p>This is a genuine paragraph with plenty of real prose content that dominates " +
    'the text well beyond the hashtags <a href="/a">#a</a><a href="/b">#b</a><a href="/c">#c</a></p>';
  assert.equal(collapseHashtagStuffing(html), html); // hashtags < 80% of text
});
