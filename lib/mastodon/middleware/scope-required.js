/**
 * Scope enforcement middleware for Mastodon Client API.
 *
 * Supports scope hierarchy: parent scope covers all children.
 *   "read" grants "read:accounts", "read:statuses", etc.
 *   "write" grants "write:statuses", "write:favourites", etc.
 *
 * Legacy "follow" scope maps to read/write for blocks, follows, and mutes.
 */

/**
 * Scopes that the legacy "follow" scope grants access to.
 */
const FOLLOW_SCOPE_EXPANSION = [
  "read:blocks",
  "write:blocks",
  "read:follows",
  "write:follows",
  "read:mutes",
  "write:mutes",
];

/**
 * Create middleware that checks if the token has the required scope.
 *
 * @param {...string} requiredScopes - One or more scopes (any match = pass)
 * @returns {Function} Express middleware
 */
export function scopeRequired(...requiredScopes) {
  return (req, res, next) => {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({
        error: "The access token is invalid",
      });
    }

    const grantedScopes = token.scopes || [];

    const hasScope = requiredScopes.some((required) =>
      checkScope(grantedScopes, required),
    );

    if (!hasScope) {
      return res.status(403).json({
        error: `This action is outside the authorized scopes. Required: ${requiredScopes.join(" or ")}`,
      });
    }

    next();
  };
}

/**
 * Check if granted scopes satisfy a required scope.
 *
 * Rules:
 * - Exact match: "read:accounts" satisfies "read:accounts"
 * - Parent match: "read" satisfies "read:accounts"
 * - "follow" expands to read/write for blocks, follows, mutes
 * - "profile" satisfies "read:accounts" (for verify_credentials)
 *
 * @param {string[]} granted - Scopes on the token
 * @param {string} required - Scope being checked
 * @returns {boolean}
 */
function checkScope(granted, required) {
  // Exact match
  if (granted.includes(required)) return true;

  // Parent scope: "read" covers "read:*", "write" covers "write:*"
  const [parent] = required.split(":");
  if (parent && granted.includes(parent)) return true;

  // Legacy "follow" scope expansion
  if (granted.includes("follow") && FOLLOW_SCOPE_EXPANSION.includes(required)) {
    return true;
  }

  // "profile" scope can satisfy "read:accounts"
  if (required === "read:accounts" && granted.includes("profile")) {
    return true;
  }

  return false;
}
