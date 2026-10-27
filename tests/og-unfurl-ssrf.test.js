/**
 * Link-preview SSRF guard (lib/og-unfurl.js).
 *
 * Security-relevant: link previews are fetched for links in posts from
 * accounts we follow, so their URLs are chosen by a third party. Every request
 * must be refused when it targets a private or reserved address, including
 * each redirect hop and the oEmbed URL a fetched page points to.
 *
 * Public targets are IP literals so the tests need no DNS, and fetch is
 * stubbed so they need no network.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { guardedFetch, isPrivateIP } from "../lib/og-unfurl.js";

const PUBLIC = "http://93.184.216.34";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stub fetch with a map of URL to response, recording what was requested.
 * @param {object} routes - URL → [status, location]
 * @returns {Array<string>} Requested URLs
 */
function stubFetch(routes) {
  const requested = [];
  globalThis.fetch = async (url, options) => {
    requested.push(String(url));
    assert.equal(options.redirect, "manual", "redirects must not be followed by fetch");
    const [status, location] = routes[String(url)] || [404];
    return new Response(status === 200 ? "<html></html>" : null, {
      status,
      headers: location ? { location } : { "content-type": "text/html" },
    });
  };
  return requested;
}

for (const [ip, expected] of [
  ["127.0.0.1", true],
  ["10.1.2.3", true],
  ["100.64.0.1", true],
  ["169.254.169.254", true],
  ["172.16.0.1", true],
  ["192.0.0.8", true],
  ["192.168.1.1", true],
  ["198.18.0.1", true],
  ["224.0.0.1", true],
  ["255.255.255.255", true],
  ["0.0.0.0", true],
  ["::", true],
  ["::1", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:7f00:1", true],
  ["::ffff:a9fe:a9fe", true],
  ["fd00::1", true],
  ["fe80::1", true],
  ["febf::1", true],
  ["8.8.8.8", false],
  ["93.184.216.34", false],
  ["::ffff:808:808", false],
  ["2606:4700:4700::1111", false],
]) {
  test(`isPrivateIP(${ip}) is ${expected}`, () => {
    assert.equal(isPrivateIP(ip), expected);
  });
}

test("guardedFetch refuses a private address given directly", async () => {
  const requested = stubFetch({});
  await assert.rejects(guardedFetch("http://[::ffff:127.0.0.1]:8080/"), /private/i);
  assert.deepEqual(requested, []);
});

test("guardedFetch refuses a redirect to a private address", async () => {
  const requested = stubFetch({
    [`${PUBLIC}/`]: [302, "http://127.0.0.1:8080/admin"],
  });
  await assert.rejects(guardedFetch(`${PUBLIC}/`), /private/i);
  assert.deepEqual(requested, [`${PUBLIC}/`], "the private hop is never requested");
});

test("guardedFetch follows redirects between public addresses", async () => {
  const requested = stubFetch({
    [`${PUBLIC}/a`]: [301, "/b"],
    [`${PUBLIC}/b`]: [200],
  });
  const response = await guardedFetch(`${PUBLIC}/a`);
  assert.equal(response.status, 200);
  assert.deepEqual(requested, [`${PUBLIC}/a`, `${PUBLIC}/b`]);
});

test("guardedFetch gives up after too many redirects", async () => {
  stubFetch({ [`${PUBLIC}/loop`]: [302, "/loop"] });
  await assert.rejects(guardedFetch(`${PUBLIC}/loop`), /redirect/i);
});
