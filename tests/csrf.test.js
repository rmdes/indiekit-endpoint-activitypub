/**
 * CSRF token generation + validation (lib/csrf.js).
 * Security: constant-time comparison (timingSafeEqual) with a length guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getToken, validateToken } from "../lib/csrf.js";

// --- getToken ---

test("getToken generates a 64-char hex token and stores it on the session", () => {
  const session = {};
  const t = getToken(session);
  assert.match(t, /^[0-9a-f]{64}$/); // 32 random bytes
  assert.equal(session._csrfToken, t);
});

test("getToken returns the same token on repeat calls (idempotent per session)", () => {
  const session = {};
  assert.equal(getToken(session), getToken(session));
});

test("getToken issues distinct tokens for distinct sessions", () => {
  assert.notEqual(getToken({}), getToken({}));
});

// --- validateToken ---

const TOKEN = "a".repeat(64);
const withSession = (extra) => ({ session: { _csrfToken: TOKEN }, body: {}, headers: {}, ...extra });

test("validateToken: no session token → false", () => {
  assert.equal(validateToken({ headers: {}, body: { _csrf: TOKEN } }), false);
});

test("validateToken: no request token → false", () => {
  assert.equal(validateToken(withSession({})), false);
});

test("validateToken: matching token in body._csrf → true", () => {
  assert.equal(validateToken(withSession({ body: { _csrf: TOKEN } })), true);
});

test("validateToken: matching token in X-CSRF-Token header → true", () => {
  assert.equal(validateToken(withSession({ headers: { "x-csrf-token": TOKEN } })), true);
});

test("validateToken: wrong token (same length) → false", () => {
  assert.equal(validateToken(withSession({ body: { _csrf: "b".repeat(64) } })), false);
});

test("validateToken: length mismatch → false (does not throw in timingSafeEqual)", () => {
  let result;
  assert.doesNotThrow(() => {
    result = validateToken(withSession({ body: { _csrf: "short" } }));
  });
  assert.equal(result, false);
});
