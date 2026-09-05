/**
 * Pagination.
 *
 * `parseLimit` still lives in lib/mastodon/helpers/pagination.js — it is pure
 * parameter parsing with no storage involved, so it stays in the adapter.
 *
 * The cursor→filter mapping it used to sit beside (`buildPaginationQuery`) was
 * deleted in Stage 4: core owns cursor encoding end to end (DD-2), so the tests
 * for that behaviour now target lib/core/cursor.js. Same guarantees, one owner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLimit } from "../lib/mastodon/helpers/pagination.js";
import { buildPage, decodeCursor, encodeCursor } from "../lib/core/cursor.js";

const OID = "a1b2c3d4e5f6a1b2c3d4e5f6"; // valid 24-char hex ObjectId

// ─── parseLimit (DEFAULT_LIMIT=20, MAX_LIMIT=40) ─────────────────────────────

test("parseLimit returns a valid in-range value unchanged", () => {
  assert.equal(parseLimit("5"), 5);
  assert.equal(parseLimit(5), 5);
});

test("parseLimit falls back to default (20) for junk / <1", () => {
  assert.equal(parseLimit("abc"), 20);
  assert.equal(parseLimit("0"), 20);
  assert.equal(parseLimit(-3), 20);
  assert.equal(parseLimit(undefined), 20);
});

test("parseLimit clamps to the maximum", () => {
  assert.equal(parseLimit("9999"), 40);
});

// ─── core/cursor ─────────────────────────────────────────────────────────────

test("decodeCursor accepts a valid ObjectId hex string", () => {
  const decoded = decodeCursor(OID);
  assert.ok(decoded);
  assert.equal(decoded.toString(), OID);
});

test("decodeCursor returns null for junk rather than throwing", () => {
  // A malformed cursor from a client must degrade to "first page", not 500.
  assert.equal(decodeCursor("not-an-id"), null);
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor(42), null);
});

test("encodeCursor round-trips a document id", () => {
  const decoded = decodeCursor(OID);
  assert.equal(encodeCursor({ _id: decoded }), OID);
});

test("encodeCursor returns null for a document without an id", () => {
  assert.equal(encodeCursor({}), null);
  assert.equal(encodeCursor(null), null);
});

test("buildPage: `before` selects strictly older items", () => {
  const { filter, sort, reverse } = buildPage({ type: "note" }, { before: OID });

  assert.equal(filter.type, "note", "base filter is preserved");
  assert.equal(filter._id.$lt.toString(), OID);
  assert.equal(reverse, false);
  assert.deepEqual(sort, { receivedAt: -1, _id: -1 });
});

test("buildPage: `after` selects strictly newer items, newest first", () => {
  const { filter, reverse } = buildPage({}, { after: OID });

  assert.equal(filter._id.$gt.toString(), OID);
  assert.equal(reverse, false);
});

test("buildPage: `since` selects newer items oldest-first, and reverses", () => {
  const { filter, sort, reverse } = buildPage({}, { since: OID });

  assert.equal(filter._id.$gt.toString(), OID);
  assert.equal(reverse, true, "caller must reverse to restore newest-first");
  assert.deepEqual(sort, { receivedAt: 1, _id: 1 });
});

test("buildPage: no cursor leaves the filter untouched", () => {
  const { filter, reverse } = buildPage({ type: "note" }, {});

  assert.deepEqual(filter, { type: "note" });
  assert.equal(reverse, false);
});

test("buildPage: an unusable cursor is ignored, not fatal", () => {
  const { filter } = buildPage({ type: "note" }, { before: "garbage" });

  assert.deepEqual(filter, { type: "note" });
});

test("buildPage: sorts on receivedAt with _id as tiebreak (DD-1)", () => {
  const { sort } = buildPage({}, {});

  // receivedAt is arrival time. `_id` breaks ties so same-millisecond arrivals
  // stay stably ordered and cursors remain unambiguous.
  assert.deepEqual(sort, { receivedAt: -1, _id: -1 });
});
