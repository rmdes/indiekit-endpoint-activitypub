/**
 * Moderation writes — one path for both lanes.
 *
 * Found 2026-09-13: the reader wrote through lib/storage/{moderation,server-blocks}.js,
 * which normalise hostnames, keep the Redis blocked-server set in sync and
 * invalidate the moderation cache. The Mastodon API wrote through
 * core/moderation.js, which did none of that. With Redis configured (as on
 * rmendes.net) the inbox's isServerBlocked reads ONLY the Redis set, so a domain
 * blocked from Phanpy kept delivering until the next restart reloaded it.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { setRedisClientForTesting } from "../lib/redis-cache.js";
import { isServerBlocked } from "../lib/storage/server-blocks.js";
import {
  blockServer,
  unblockServer,
  getBlockedServers,
  mute,
  blockAccount,
} from "../lib/core/moderation.js";

let mongo;

/** Minimal ioredis set double. */
function fakeRedis() {
  const sets = new Map();
  const set = (k) => sets.get(k) ?? sets.set(k, new Set()).get(k);
  return {
    async sadd(k, ...v) { v.forEach((x) => set(k).add(x)); return v.length; },
    async srem(k, ...v) { v.forEach((x) => set(k).delete(x)); return v.length; },
    async sismember(k, v) { return set(k).has(v) ? 1 : 0; },
    async del(k) { sets.delete(k); return 1; },
  };
}

before(async () => {
  mongo = await withMongo();
});

after(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.reset();
  setRedisClientForTesting(fakeRedis());
});

afterEach(() => {
  setRedisClientForTesting(null);
});

describe("core/moderation domain blocks reach the inbox gate", () => {
  it("a domain blocked through core is blocked for the inbox (Redis path)", async () => {
    await blockServer(mongo.collections, "Spam.Example");

    assert.equal(
      await isServerBlocked("https://spam.example/users/x", mongo.collections),
      true,
    );
    assert.deepEqual(await getBlockedServers(mongo.collections), ["spam.example"]);
  });

  it("unblocking through core lifts the inbox block", async () => {
    await blockServer(mongo.collections, "spam.example");
    await unblockServer(mongo.collections, "SPAM.example");

    assert.equal(
      await isServerBlocked("https://spam.example/users/x", mongo.collections),
      false,
    );
    assert.deepEqual(await getBlockedServers(mongo.collections), []);
  });
});

describe("core/moderation records use the shared field names", () => {
  it("mutes and blocks carry mutedAt / blockedAt like reader-written rows", async () => {
    await mute(mongo.collections, { url: "https://remote.example/users/a" });
    await blockAccount(mongo.collections, "https://remote.example/users/b");

    const muted = await mongo.collections.ap_muted.findOne({});
    const blocked = await mongo.collections.ap_blocked.findOne({});
    assert.ok(muted.mutedAt, "reader lists read mutedAt");
    assert.ok(blocked.blockedAt, "reader lists read blockedAt");
  });
});
