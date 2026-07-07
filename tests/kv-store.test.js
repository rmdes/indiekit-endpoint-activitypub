/**
 * MongoKvStore (lib/kv-store.js).
 *
 * list() must anchor its prefix on the "/" separator so a prefix like
 * ["cache","actor"] does not leak sibling keys such as "cache/actors/x".
 * set() must translate a Fedify Temporal-style ttl into a BSON Date `expireAt`
 * (reaped by the sparse TTL index) and omit it when no ttl is given.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MongoKvStore } from "../lib/kv-store.js";

function mockCollection() {
  const state = { docs: [], lastUpdate: null };
  return {
    state,
    find(filter) {
      const regex = filter?._id?.$regex ? new RegExp(filter._id.$regex) : null;
      const matched = regex
        ? state.docs.filter((d) => regex.test(d._id))
        : state.docs;
      return {
        async *[Symbol.asyncIterator]() {
          for (const d of matched) yield d;
        },
      };
    },
    async updateOne(query, update, opts) {
      state.lastUpdate = { query, update, opts };
    },
  };
}

test("list: prefix is anchored on the separator (no sibling contamination)", async () => {
  const col = mockCollection();
  col.state.docs = [
    { _id: "cache/actor", value: 1 },
    { _id: "cache/actor/x", value: 2 },
    { _id: "cache/actors/y", value: 3 }, // must NOT match prefix ["cache","actor"]
  ];
  const kv = new MongoKvStore(col);
  const keys = [];
  for await (const e of kv.list(["cache", "actor"])) keys.push(e.key.join("/"));
  assert.deepEqual(keys.sort(), ["cache/actor", "cache/actor/x"]);
});

test("set: no ttl → no expireAt field", async () => {
  const col = mockCollection();
  await new MongoKvStore(col).set(["k"], "v");
  assert.equal(col.state.lastUpdate.update.$set.expireAt, undefined);
});

test("set: ttl → future BSON Date expireAt", async () => {
  const col = mockCollection();
  const ttl = { total: (unit) => (unit === "milliseconds" ? 60_000 : 0) };
  await new MongoKvStore(col).set(["k"], "v", { ttl });
  const exp = col.state.lastUpdate.update.$set.expireAt;
  assert.ok(exp instanceof Date, "expireAt must be a Date for the MongoDB TTL index");
  assert.ok(exp.getTime() > Date.now() + 30_000, "expireAt ~1 min in the future");
});
