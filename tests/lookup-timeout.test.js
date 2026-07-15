/**
 * withTimeout() bounds remote lookups so a hung remote server can't wedge the
 * calling request forever (the "Phanpy spinner never resolves, must force-close
 * the app" bug). If the timeout wins, it must resolve null (callers treat null
 * as "unresolvable" and degrade gracefully); if the work wins, its value passes
 * through unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _withTimeout as withTimeout } from "../lib/lookup-helpers.js";

test("resolves the work value when it finishes before the timeout", async () => {
  const fast = new Promise((r) => setTimeout(() => r("actor"), 5));
  const result = await withTimeout(fast, 100);
  assert.equal(result, "actor");
});

test("resolves null when the work outlives the timeout (no hang)", async () => {
  const neverSettles = new Promise(() => {}); // simulates a black-holed socket
  const start = Date.now();
  const result = await withTimeout(neverSettles, 30);
  assert.equal(result, null);
  assert.ok(Date.now() - start < 500, "returned promptly, did not hang");
});
