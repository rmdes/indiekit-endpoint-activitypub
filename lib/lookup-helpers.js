/**
 * Centralized wrapper for ctx.lookupObject() with FEP-fe34 origin-based
 * security. All lookupObject calls MUST go through this helper so the
 * crossOrigin policy is applied consistently.
 *
 * @module lookup-helpers
 */

// Upper bound for a single remote lookup. A remote server that is slow or
// black-holes the connection must NOT wedge the calling request forever:
// Mastodon API handlers await these lookups inline, so an unbounded lookup
// means the HTTP response never sends and clients (Phanpy/Phandroid) hang with
// a spinner that never resolves. 8s is generous for a slow-but-alive server
// while still bounding the worst case. ponytail: single constant, tune if real
// servers legitimately need longer.
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * Race a promise against a timeout. Resolves to null if the timeout wins, so
 * callers (which all treat null as "unresolvable") degrade gracefully instead
 * of hanging. The AbortSignal is also passed to lookupObject so Fedify can
 * cancel the underlying fetch when it honors the signal — belt and suspenders,
 * since the whole failure mode here is a socket that never settles.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Test-only export (see tests/lookup-timeout.test.js).
export { withTimeout as _withTimeout };

/**
 * Look up a remote ActivityPub object with cross-origin security.
 *
 * FEP-fe34 prevents spoofed attribution attacks by verifying that a
 * fetched object's `id` matches the origin of the URL used to fetch it.
 * Using `crossOrigin: "ignore"` tells Fedify to silently discard objects
 * whose id doesn't match the fetch origin, rather than throwing.
 *
 * When an authenticated document loader is provided (for Authorized Fetch
 * compatibility), the lookup is tried with it first. If it fails (some
 * servers like tags.pub return 400 for signed GETs), a fallback to the
 * default unsigned loader is attempted automatically.
 *
 * @param {object} ctx - Fedify Context
 * @param {string|URL} input - URL or handle to look up
 * @param {object} [options] - Additional options passed to lookupObject
 * @returns {Promise<object|null>} Resolved object or null
 */
export async function lookupWithSecurity(ctx, input, options = {}) {
  const baseOptions = {
    crossOrigin: "ignore",
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    ...options,
  };

  let result = null;
  try {
    result = await withTimeout(
      ctx.lookupObject(input, baseOptions),
      LOOKUP_TIMEOUT_MS,
    );
  } catch {
    // signed lookup threw (including AbortError on timeout) — fall through
  }

  // If signed lookup failed and we used a custom documentLoader,
  // retry without it (unsigned GET) — with a fresh timeout budget.
  if (!result && options.documentLoader) {
    try {
      const { documentLoader: _, ...unsignedOptions } = baseOptions;
      unsignedOptions.signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
      result = await withTimeout(
        ctx.lookupObject(input, unsignedOptions),
        LOOKUP_TIMEOUT_MS,
      );
    } catch {
      // unsigned also failed — return null
    }
  }

  return result;
}
