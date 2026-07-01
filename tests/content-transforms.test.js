/**
 * Pure content post-processing helpers (applied after sanitize in the item
 * pipeline): content-utils.js + emoji-utils.js. All pure string transforms.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { shortenDisplayUrls, collapseHashtagStuffing } from "../lib/content-utils.js";
import { replaceCustomEmoji } from "../lib/emoji-utils.js";

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

// --- replaceCustomEmoji ---

test("replaceCustomEmoji: replaces :shortcode: with an <img> tag", () => {
  const out = replaceCustomEmoji("hi :blobcat: there", [
    { shortcode: "blobcat", url: "https://emoji.example/blobcat.png" },
  ]);
  assert.ok(out.includes('<img src="https://emoji.example/blobcat.png"'));
  assert.ok(out.includes('alt=":blobcat:"')); // shortcode is preserved in alt/title by design
  assert.ok(out.startsWith("hi <img"), "shortcode in body replaced by the img");
  assert.ok(out.endsWith("> there"), "surrounding text preserved");
});

test("replaceCustomEmoji: no emojis or no html → passthrough", () => {
  assert.equal(replaceCustomEmoji("hi :x:", []), "hi :x:");
  assert.equal(replaceCustomEmoji("", [{ shortcode: "a", url: "u" }]), "");
});

test("replaceCustomEmoji: only replaces defined shortcodes, leaves others literal", () => {
  const out = replaceCustomEmoji(":known: :unknown:", [
    { shortcode: "known", url: "https://e/k.png" },
  ]);
  assert.ok(out.includes("<img"));
  assert.ok(out.includes(":unknown:"), "undefined shortcode left as-is");
});
