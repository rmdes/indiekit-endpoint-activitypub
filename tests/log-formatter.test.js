/**
 * Compact LogTape formatting (lib/federation-setup.js).
 *
 * Fedify logs failures as `logger.error("... {error}", { error })`. LogTape's
 * default console formatter INSPECTS that error object, printing the stack plus
 * every header of the remote's HTTP response — measured on rmendes over 20h,
 * 175 delivery failures produced a median of 26 lines each and a p90 of 492,
 * about 29% of all container output. That buried the build logs we needed to
 * diagnose a slow build twice on 2026-10-08.
 *
 * The contract these tests defend: ONE LINE PER RECORD, always. A record that
 * spans lines is a record that cannot be grepped as a single event.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderLogValue, compactLogFormatter } from "../lib/federation-setup.js";

const record = (overrides = {}) => ({
  category: ["fedify", "federation", "outbox"],
  level: "error",
  message: ["plain message"],
  rawMessage: "plain message",
  timestamp: Date.parse("2026-10-08T17:28:38.123Z"),
  properties: {},
  ...overrides,
});

// --- renderLogValue ---

test("an Error renders as its first message line only", () => {
  const error = new Error("Failed to send activity to https://x/inbox (503)\nsecond line");
  error.stack = "Error: boom\n    at a\n    at b\n    at c";
  assert.equal(
    renderLogValue(error),
    "Failed to send activity to https://x/inbox (503)",
  );
});

test("an Error with no message still renders something", () => {
  const e = new Error("");
  assert.ok(renderLogValue(e).length > 0);
});

test("strings pass through; null and undefined are explicit", () => {
  assert.equal(renderLogValue("hello"), "hello");
  assert.equal(renderLogValue(null), "null");
  assert.equal(renderLogValue(undefined), "undefined");
});

test("objects are JSON and capped, so one record cannot dump a whole activity", () => {
  assert.equal(renderLogValue({ a: 1 }), '{"a":1}');
  const big = renderLogValue({ pad: "x".repeat(500) });
  assert.ok(big.length <= 201, `expected <=201 chars, got ${big.length}`);
  assert.ok(big.endsWith("…"), "a truncated value must say so");
});

test("an unserialisable object does not throw", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(renderLogValue(cyclic), "[unserialisable]");
});

// --- compactLogFormatter ---

test("output is exactly one line, newline-terminated", () => {
  const out = compactLogFormatter(record());
  assert.equal(out.split("\n").length, 2, "one line plus the trailing newline");
  assert.ok(out.endsWith("\n"));
});

test("carries time, level label and dotted category", () => {
  const out = compactLogFormatter(record());
  assert.match(out, /^17:28:38\.123 ERR fedify·federation·outbox plain message\n$/);
});

test("every level maps to a three-letter label", () => {
  for (const [level, label] of Object.entries({
    debug: "DBG",
    info: "INF",
    warning: "WRN",
    error: "ERR",
    fatal: "FTL",
  })) {
    assert.match(compactLogFormatter(record({ level })), new RegExp(` ${label} `));
  }
});

test("THE REGRESSION: a template embedding an Error collapses to one line", () => {
  // Shape Fedify actually uses: literal, value, literal, value, literal...
  const error = new Error(
    "Failed to send activity https://rmendes.net/activitypub/users/rick#create " +
      "to https://mastodon.example/inbox (503 Service Unavailable):\n<html>…</html>",
  );
  error.stack = "SendActivityError: …\n  at async #listenOutboxMessage\n  at async #work";
  const out = compactLogFormatter(
    record({ message: ["Failed to send activity:\n", error, "\n"] }),
  );

  assert.equal(out.split("\n").length, 2, "must not span lines");
  assert.ok(out.includes("503 Service Unavailable"), "keeps the useful fact");
  assert.ok(!out.includes("listenOutboxMessage"), "drops the stack");
  assert.ok(!out.includes("<html>"), "drops the remote's response body");
});

test("interleaved values are rendered, literals are not mangled", () => {
  const out = compactLogFormatter(
    record({ message: ["sent ", "abc", " to ", "https://x/inbox", ""] }),
  );
  assert.match(out, /sent abc to https:\/\/x\/inbox\n$/);
});

test("a non-array category still formats", () => {
  const out = compactLogFormatter(record({ category: "fedify" }));
  assert.match(out, / fedify plain message\n$/);
});
