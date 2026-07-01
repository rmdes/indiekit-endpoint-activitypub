/**
 * Inbox addressing/visibility classification (lib/inbox-handlers.js).
 *
 * Security-relevant: these decide whether verified-but-untrusted remote content
 * is treated as a private DM and how each ingested post's visibility is stored.
 * Both are pure over a Fedify object's addressing arrays (to/cc/bto/bcc), so we
 * test them directly with plain objects — no federation, no mocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  _isDirectMessage as isDirectMessage,
  _computeVisibility as computeVisibility,
} from "../lib/inbox-handlers.js";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const US = "https://rmendes.net/";
const FOLLOWERS = "https://rmendes.net/followers";
const href = (arr) => (arr || []).map((u) => ({ href: u }));

// isDirectMessage merges to/cc/bto/bcc; all four arrays must be present.
const obj = ({ to = [], cc = [], bto = [], bcc = [] } = {}) => ({
  toIds: href(to),
  ccIds: href(cc),
  btoIds: href(bto),
  bccIds: href(bcc),
});

// --- isDirectMessage ---

test("isDirectMessage: addressed only to us, not public/followers → true", () => {
  assert.equal(isDirectMessage(obj({ to: [US] }), US, FOLLOWERS), true);
});

test("isDirectMessage: recognises us when addressed via cc/bto/bcc (all fields merged)", () => {
  assert.equal(isDirectMessage(obj({ cc: [US] }), US, FOLLOWERS), true);
  assert.equal(isDirectMessage(obj({ bto: [US] }), US, FOLLOWERS), true);
  assert.equal(isDirectMessage(obj({ bcc: [US] }), US, FOLLOWERS), true);
});

test("isDirectMessage: not addressed to us → false", () => {
  assert.equal(isDirectMessage(obj({ to: ["https://someone.else/"] }), US, FOLLOWERS), false);
});

test("isDirectMessage: includes Public collection → false (not a DM)", () => {
  assert.equal(isDirectMessage(obj({ to: [US, PUBLIC] }), US, FOLLOWERS), false);
  assert.equal(isDirectMessage(obj({ to: [US], cc: ["as:Public"] }), US, FOLLOWERS), false);
});

test("isDirectMessage: includes our followers collection → false (followers-only, not DM)", () => {
  assert.equal(isDirectMessage(obj({ to: [US, FOLLOWERS] }), US, FOLLOWERS), false);
});

test("isDirectMessage: no followersUrl known → followers check is skipped", () => {
  // Without a followers URL, a post to us + a followers-like URL is still a DM
  assert.equal(isDirectMessage(obj({ to: [US, FOLLOWERS] }), US, null), true);
});

// --- computeVisibility ---

test("computeVisibility: Public in to → public", () => {
  assert.equal(computeVisibility(obj({ to: [PUBLIC], cc: [FOLLOWERS] })), "public");
});

test("computeVisibility: Public in cc (not to) → unlisted", () => {
  assert.equal(computeVisibility(obj({ to: [FOLLOWERS], cc: [PUBLIC] })), "unlisted");
});

test("computeVisibility: no Public but to/cc non-empty → private", () => {
  assert.equal(computeVisibility(obj({ to: [FOLLOWERS] })), "private");
  assert.equal(computeVisibility(obj({ cc: [US] })), "private");
});

test("computeVisibility: no addressing at all → direct", () => {
  assert.equal(computeVisibility(obj()), "direct");
});
