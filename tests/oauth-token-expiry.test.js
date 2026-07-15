/**
 * Regression guard: the authorization_code exchange must NOT leak the code's
 * 10-minute `expiresAt` onto the (permanent) access token.
 *
 * The token doc is the SAME document as the authorization code (upgraded in
 * place). The code carries `expiresAt` (its 10-min lifetime); if the exchange
 * doesn't $unset it, resolveToken() 401s every request ~10 min after login —
 * the "timeline loads once then stops refreshing / must re-add account" bug.
 * Access tokens never expire (Mastodon parity), so a freshly issued token doc
 * must have no `expiresAt`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import oauthRouter from "../lib/mastodon/routes/oauth.js";

/**
 * Minimal in-memory ap_oauth_tokens mock holding a single doc. Only the query
 * shapes the token handler actually uses are honored; the seeded doc is matched
 * by presence, not full Mongo query semantics.
 */
function fakeCollection(seed) {
  let doc = { ...seed };
  return {
    peek: () => doc,
    async findOne() {
      return doc ? { ...doc } : null;
    },
    async findOneAndUpdate(_q, update, opts) {
      const before = { ...doc };
      if (update.$set) Object.assign(doc, update.$set);
      return opts?.returnDocument === "before" ? before : { ...doc };
    },
    async updateOne(_q, update) {
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) delete doc[k];
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

async function withServer(collections, fn) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.app.locals.mastodonCollections = collections;
    req.app.locals.apSettings = {};
    next();
  });
  app.use(oauthRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("authorization_code exchange clears the inherited code expiry", async () => {
  const codeExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min, like a real code
  const collections = {
    ap_oauth_tokens: fakeCollection({
      code: "CODE123",
      usedAt: null,
      revokedAt: null,
      expiresAt: codeExpiry, // <- the poison that must be cleared
      clientId: "client1",
      scopes: ["read", "write"],
      createdAt: new Date(),
    }),
  };

  const body = await withServer(collections, async (base) => {
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "CODE123",
        client_id: "client1",
      }),
    });
    assert.equal(res.status, 200, "code exchange should succeed");
    return res.json();
  });

  assert.ok(body.access_token, "response returns an access token");

  const stored = collections.ap_oauth_tokens.peek();
  assert.equal(stored.accessToken, body.access_token, "token persisted");
  assert.equal(
    stored.expiresAt,
    undefined,
    "access token must NOT carry the code's expiresAt (permanent token)",
  );
  assert.ok(stored.refreshExpiresAt, "refresh token still gets its own expiry");
});
