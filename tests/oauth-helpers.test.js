/**
 * OAuth2 pure helpers (lib/mastodon/routes/oauth.js).
 * Security-relevant: HTML escaping on the authorize page, client-secret hashing,
 * and redirect_uri/scope parsing. Pure; test-only _-prefixed exports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  _escapeHtml as escapeHtml,
  _hashSecret as hashSecret,
  _parseRedirectUris as parseRedirectUris,
  _parseScopes as parseScopes,
} from "../lib/mastodon/routes/oauth.js";

// --- escapeHtml ---

test("escapeHtml escapes all five HTML-significant characters", () => {
  assert.equal(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#x27;");
});

test("escapeHtml coerces null/undefined to empty string", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

// --- hashSecret ---

test("hashSecret is a deterministic 64-char sha256 hex", () => {
  const a = hashSecret("s3cret");
  assert.equal(a, hashSecret("s3cret"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("hashSecret differs for different secrets", () => {
  assert.notEqual(hashSecret("a"), hashSecret("b"));
});

// --- parseRedirectUris ---

test("parseRedirectUris defaults to the OOB URN when empty", () => {
  assert.deepEqual(parseRedirectUris(""), ["urn:ietf:wg:oauth:2.0:oob"]);
  assert.deepEqual(parseRedirectUris(null), ["urn:ietf:wg:oauth:2.0:oob"]);
});

test("parseRedirectUris splits a space-separated string", () => {
  assert.deepEqual(
    parseRedirectUris("https://a.example/cb https://b.example/cb"),
    ["https://a.example/cb", "https://b.example/cb"],
  );
});

test("parseRedirectUris trims an array of URIs", () => {
  assert.deepEqual(
    parseRedirectUris(["https://a.example/cb ", " https://b.example/cb"]),
    ["https://a.example/cb", "https://b.example/cb"],
  );
});

// --- parseScopes ---

test("parseScopes defaults to ['read'] when empty", () => {
  assert.deepEqual(parseScopes(""), ["read"]);
  assert.deepEqual(parseScopes(null), ["read"]);
});

test("parseScopes splits and trims a scope string", () => {
  assert.deepEqual(parseScopes("  read   write  follow "), ["read", "write", "follow"]);
});
