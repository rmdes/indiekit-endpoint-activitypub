/**
 * Mastodon pagination helpers (lib/mastodon/helpers/pagination.js).
 * parseLimit clamping + buildPaginationQuery cursor→Mongo-filter mapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLimit, buildPaginationQuery } from "../lib/mastodon/helpers/pagination.js";

const OID = "a1b2c3d4e5f6a1b2c3d4e5f6"; // valid 24-char hex ObjectId

// --- parseLimit (DEFAULT_LIMIT=20, MAX_LIMIT=40) ---

test("parseLimit returns a valid in-range value unchanged", () => {
  assert.equal(parseLimit("5"), 5);
  assert.equal(parseLimit(5), 5);
});

test("parseLimit falls back to default (20) for junk / <1", () => {
  assert.equal(parseLimit("abc"), 20);
  assert.equal(parseLimit("0"), 20);
  assert.equal(parseLimit("-3"), 20);
  assert.equal(parseLimit(undefined), 20);
});

test("parseLimit clamps to max (40)", () => {
  assert.equal(parseLimit("100"), 40);
  assert.equal(parseLimit("40"), 40);
});

// --- buildPaginationQuery ---

test("buildPaginationQuery: no cursors → newest-first, base filter preserved", () => {
  const { filter, sort, reverse } = buildPaginationQuery({ visibility: "public" }, {});
  assert.deepEqual(sort, { _id: -1 });
  assert.equal(reverse, false);
  assert.equal(filter.visibility, "public");
  assert.equal(filter._id, undefined);
});

test("buildPaginationQuery: max_id → _id.$lt, newest-first", () => {
  const { filter, sort, reverse } = buildPaginationQuery({}, { max_id: OID });
  assert.ok(filter._id.$lt, "sets $lt");
  assert.deepEqual(sort, { _id: -1 });
  assert.equal(reverse, false);
});

test("buildPaginationQuery: since_id → _id.$gt, newest-first", () => {
  const { filter, sort } = buildPaginationQuery({}, { since_id: OID });
  assert.ok(filter._id.$gt, "sets $gt");
  assert.deepEqual(sort, { _id: -1 });
});

test("buildPaginationQuery: min_id → _id.$gt, oldest-first + reverse", () => {
  const { filter, sort, reverse } = buildPaginationQuery({}, { min_id: OID });
  assert.ok(filter._id.$gt, "sets $gt");
  assert.deepEqual(sort, { _id: 1 });
  assert.equal(reverse, true);
});

test("buildPaginationQuery: invalid cursor is ignored (no _id filter)", () => {
  const { filter, sort } = buildPaginationQuery({}, { max_id: "not-an-objectid" });
  assert.equal(filter._id, undefined);
  assert.deepEqual(sort, { _id: -1 });
});
