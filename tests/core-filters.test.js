/**
 * core/filters — keyword filters.
 *
 * The first draft of core/filters.js stored `filterId` as a STRING, while every
 * existing document and mastodon/helpers/apply-filters.js use an ObjectId. That
 * mismatch is silent and nasty: filters would still list, keywords would come
 * back empty, and filtering would quietly stop working with nothing in the
 * logs. These tests exist mainly to make that shape explicit.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import {
  createFilter,
  deleteFilter,
  getFilter,
  getFilters,
  replaceKeywords,
  updateFilter,
} from "../lib/core/filters.js";

let mongo;

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.reset();
});

async function seedFilter(title = "spoilers") {
  return createFilter(
    mongo.collections,
    { title, context: ["home"], filterAction: "warn", expiresAt: null },
    [
      { keyword: "ending", wholeWord: true },
      { keyword: "finale", wholeWord: false },
    ],
  );
}

describe("core/filters", () => {
  it("stores filterId as an ObjectId, matching existing documents", async () => {
    const filter = await seedFilter();

    const keyword = await mongo.collections.ap_filter_keywords.findOne({});

    assert.notEqual(
      typeof keyword.filterId,
      "string",
      "filterId must be an ObjectId — a string silently orphans every keyword " +
        "and filtering stops with no error anywhere",
    );
    assert.equal(String(keyword.filterId), String(filter._id));
  });

  it("keywords written by core are readable by the legacy query shape", async () => {
    const filter = await seedFilter();

    // This is exactly what mastodon/helpers/apply-filters.js does.
    const viaLegacy = await mongo.collections.ap_filter_keywords
      .find({ filterId: filter._id })
      .toArray();

    assert.equal(viaLegacy.length, 2);
  });

  it("creates a filter with its keywords attached", async () => {
    const filter = await seedFilter();

    assert.equal(filter.title, "spoilers");
    assert.deepEqual(filter.context, ["home"]);
    assert.equal(filter.keywords.length, 2);
  });

  it("lists filters with keywords, without an N+1", async () => {
    await seedFilter("one");
    await seedFilter("two");

    const filters = await getFilters(mongo.collections);

    assert.equal(filters.length, 2);
    assert.ok(filters.every((f) => f.keywords.length === 2));
  });

  it("groups keywords to the right filter", async () => {
    const a = await seedFilter("a");
    const b = await seedFilter("b");

    const filters = await getFilters(mongo.collections);
    const byId = new Map(filters.map((f) => [String(f._id), f]));

    assert.equal(byId.get(String(a._id)).keywords.length, 2);
    assert.equal(byId.get(String(b._id)).keywords.length, 2);
  });

  it("fetches one filter by opaque id", async () => {
    const created = await seedFilter();
    const found = await getFilter(mongo.collections, created._id.toString());

    assert.equal(found.title, "spoilers");
    assert.equal(found.keywords.length, 2);
  });

  it("returns null for a malformed id rather than throwing", async () => {
    assert.equal(await getFilter(mongo.collections, "not-an-id"), null);
    assert.equal(await deleteFilter(mongo.collections, "not-an-id"), 0);
  });

  it("updates fields and keeps keywords", async () => {
    const created = await seedFilter();

    const updated = await updateFilter(mongo.collections, created._id.toString(), {
      title: "renamed",
    });

    assert.equal(updated.title, "renamed");
    assert.equal(updated.keywords.length, 2);
  });

  it("deletes keywords alongside the filter", async () => {
    const created = await seedFilter();

    await deleteFilter(mongo.collections, created._id.toString());

    assert.equal(await mongo.collections.ap_filters.countDocuments(), 0);
    assert.equal(
      await mongo.collections.ap_filter_keywords.countDocuments(),
      0,
      "orphaned keywords would keep filtering with no filter to disable",
    );
  });

  it("replaceKeywords swaps the set wholesale", async () => {
    const created = await seedFilter();

    await replaceKeywords(mongo.collections, created._id.toString(), [
      { keyword: "different", wholeWord: true },
    ]);

    const after = await getFilter(mongo.collections, created._id.toString());

    assert.equal(after.keywords.length, 1);
    assert.equal(after.keywords[0].keyword, "different");
  });
});
