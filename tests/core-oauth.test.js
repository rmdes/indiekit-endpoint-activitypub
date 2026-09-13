/**
 * core/oauth#resolveAccessToken — the Bearer token policy, moved out of the
 * tokenRequired middleware.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withMongo } from "./helpers/mongo.js";
import { resolveAccessToken } from "../lib/core/oauth.js";

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

const add = (doc) =>
  mongo.collections.ap_oauth_tokens.insertOne({ revokedAt: null, ...doc });
const resolve = (t) => resolveAccessToken(mongo.collections, t);

describe("resolveAccessToken", () => {
  it("accepts a live token", async () => {
    await add({ accessToken: "live" });
    assert.equal((await resolve("live"))?.accessToken, "live");
  });

  it("rejects unknown, empty and revoked tokens", async () => {
    await add({ accessToken: "gone", revokedAt: new Date().toISOString() });
    assert.equal(await resolve("nope"), null);
    assert.equal(await resolve(""), null);
    assert.equal(await resolve("gone"), null);
  });

  it("rejects app-only (client_credentials) tokens", async () => {
    await add({ accessToken: "app", appOnly: true });
    assert.equal(await resolve("app"), null);
  });

  it("honours expiresAt stored as a Date or an ISO string", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    await add({ accessToken: "past-date", expiresAt: past });
    await add({ accessToken: "past-iso", expiresAt: past.toISOString() });
    // A string compared to a Date coerces the Date to "Sun Sep …", so a
    // future ISO expiry used to be rejected ("2" < "S").
    await add({ accessToken: "future-iso", expiresAt: future.toISOString() });

    assert.equal(await resolve("past-date"), null);
    assert.equal(await resolve("past-iso"), null);
    assert.equal((await resolve("future-iso"))?.accessToken, "future-iso");
  });
});
