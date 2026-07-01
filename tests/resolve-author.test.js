/**
 * extractAuthorUrl (lib/resolve-author.js) — post URL → canonical author URL.
 *
 * Regression guard for the documented gotcha #14: the regex must capture the
 * real username, NOT the literal "users"/"statuses" path segment. Pure, no net.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractAuthorUrl } from "../lib/resolve-author.js";

test("extractAuthorUrl: /users/NAME/statuses/ID → /users/NAME (Mastodon/GoToSocial/Akkoma)", () => {
  assert.equal(
    extractAuthorUrl("https://mastodon.social/users/NatalieDavis/statuses/123"),
    "https://mastodon.social/users/NatalieDavis",
  );
});

test("extractAuthorUrl: /@NAME/ID → /users/NAME (Mastodon display URL)", () => {
  assert.equal(
    extractAuthorUrl("https://mastodon.social/@alice/109876543210"),
    "https://mastodon.social/users/alice",
  );
});

test("extractAuthorUrl: /p/NAME/ID → /users/NAME (Pixelfed)", () => {
  assert.equal(
    extractAuthorUrl("https://pixelfed.social/p/bob/456"),
    "https://pixelfed.social/users/bob",
  );
});

test("extractAuthorUrl: captures the real username, never a path keyword (gotcha #14)", () => {
  const out = extractAuthorUrl("https://gts.example/users/NatalieDavis/statuses/1");
  assert.ok(out.endsWith("/NatalieDavis"), `expected username, got ${out}`);
  assert.ok(!out.endsWith("/users"));
  assert.ok(!out.endsWith("/statuses"));
});

test("extractAuthorUrl: no username in URL → null", () => {
  assert.equal(extractAuthorUrl("https://example.social/notice/789"), null);
});

test("extractAuthorUrl: a bare actor URL (no post segment) → null", () => {
  // /users/alice without a trailing /statuses/... is not a post URL
  assert.equal(extractAuthorUrl("https://mastodon.social/users/alice"), null);
});

test("extractAuthorUrl: invalid input → null (no throw)", () => {
  assert.equal(extractAuthorUrl("not a url"), null);
  assert.equal(extractAuthorUrl(""), null);
});
