/**
 * Bearer token validation middleware for Mastodon Client API.
 *
 * Extracts the Bearer token from the Authorization header,
 * validates it against the ap_oauth_tokens collection,
 * and attaches token data to `req.mastodonToken`.
 */

/**
 * Require a valid Bearer token. Returns 401 if invalid/missing.
 */
export async function tokenRequired(req, res, next) {
  const token = await resolveToken(req);

  if (!token) {
    return res.status(401).json({
      error: "The access token is invalid",
    });
  }

  req.mastodonToken = token;
  next();
}

/**
 * Optional token — sets req.mastodonToken to null if absent.
 * For public endpoints that personalize when authenticated.
 */
export async function optionalToken(req, res, next) {
  req.mastodonToken = await resolveToken(req);
  next();
}

/**
 * Extract and validate Bearer token from request.
 * @returns {object|null} Token document or null
 */
async function resolveToken(req) {
  const authHeader = req.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const accessToken = authHeader.slice(7);
  if (!accessToken) return null;

  const collections = req.app.locals.mastodonCollections;
  const token = await collections.ap_oauth_tokens.findOne({
    accessToken,
    revokedAt: null,
  });

  if (!token) return null;

  // Check expiry if set
  if (token.expiresAt && token.expiresAt < new Date()) return null;

  return token;
}
