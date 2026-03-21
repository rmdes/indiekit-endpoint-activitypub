/**
 * Centralized wrapper for ctx.lookupObject() with FEP-fe34 origin-based
 * security. All lookupObject calls MUST go through this helper so the
 * crossOrigin policy is applied consistently.
 *
 * @module lookup-helpers
 */

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
  const baseOptions = { crossOrigin: "ignore", ...options };

  let result = null;
  try {
    result = await ctx.lookupObject(input, baseOptions);
  } catch {
    // signed lookup threw — fall through to unsigned
  }

  // If signed lookup failed and we used a custom documentLoader,
  // retry without it (unsigned GET)
  if (!result && options.documentLoader) {
    try {
      const { documentLoader: _, ...unsignedOptions } = baseOptions;
      result = await ctx.lookupObject(input, unsignedOptions);
    } catch {
      // unsigned also failed — return null
    }
  }

  return result;
}
