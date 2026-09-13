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

/** Collection double: findOne returns the anchor document (or null). */
const anchorAt = (doc) => ({ findOne: async () => doc });
const ANCHOR = { _id: decodeCursor(OID), receivedAt: "2026-08-01T12:00:00.000Z" };

test("buildPage: `before` pages on (receivedAt, _id), not _id alone", async () => {
  const { filter, sort, reverse } = await buildPage(
    anchorAt(ANCHOR), { type: "note" }, { before: OID },
  );

  assert.deepEqual(filter.$and[0], { type: "note" }, "base filter is preserved");
  assert.deepEqual(filter.$and[1], {
    $or: [
      { receivedAt: { $lt: ANCHOR.receivedAt } },
      { receivedAt: ANCHOR.receivedAt, _id: { $lt: ANCHOR._id } },
    ],
  });
  assert.equal(reverse, false);
  assert.deepEqual(sort, { receivedAt: -1, _id: -1 });
});

test("buildPage: `after` selects strictly newer items, newest first", async () => {
  const { filter, reverse } = await buildPage(anchorAt(ANCHOR), {}, { after: OID });

  assert.equal(filter.$and[1].$or[0].receivedAt.$gt, ANCHOR.receivedAt);
  assert.equal(reverse, false);
});

test("buildPage: `since` selects newer items oldest-first, and reverses", async () => {
  const { filter, sort, reverse } = await buildPage(anchorAt(ANCHOR), {}, { since: OID });

  assert.equal(filter.$and[1].$or[0].receivedAt.$gt, ANCHOR.receivedAt);
  assert.equal(reverse, true, "caller must reverse to restore newest-first");
  assert.deepEqual(sort, { receivedAt: 1, _id: 1 });
});

test("buildPage: a cursor whose document is gone falls back to _id", async () => {
  const { filter } = await buildPage(anchorAt(null), {}, { before: OID });

  assert.equal(filter.$and[1]._id.$lt.toString(), OID);
});

test("buildPage: sortField `_id` needs no lookup", async () => {
  const noLookup = { findOne: async () => assert.fail("must not look up") };
  const { filter, sort } = await buildPage(noLookup, { type: "like" }, { before: OID }, "_id");

  assert.equal(filter.$and[1]._id.$lt.toString(), OID);
  assert.deepEqual(sort, { _id: -1 });
});

test("buildPage: no cursor leaves the filter untouched", async () => {
  const { filter, reverse, cursored } = await buildPage(anchorAt(ANCHOR), { type: "note" }, {});

  assert.deepEqual(filter, { type: "note" });
  assert.equal(reverse, false);
  assert.equal(cursored, false);
});

test("buildPage: an unusable cursor is ignored, not fatal", async () => {
  const { filter } = await buildPage(anchorAt(ANCHOR), { type: "note" }, { before: "garbage" });

  assert.deepEqual(filter, { type: "note" });
});

test("buildPage: sorts on receivedAt with _id as tiebreak (DD-1)", async () => {
  const { sort } = await buildPage(anchorAt(ANCHOR), {}, {});

  // receivedAt is arrival time. `_id` breaks ties so same-millisecond arrivals
  // stay stably ordered and cursors remain unambiguous.
  assert.deepEqual(sort, { receivedAt: -1, _id: -1 });
});
