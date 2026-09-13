/**
 * Bearer token validation middleware for Mastodon Client API.
 *
 * Extracts the Bearer token from the Authorization header,
 * validates it against the ap_oauth_tokens collection,
 * and attaches token data to `req.mastodonToken`.
 */
import { resolveAccessToken } from "../../core/oauth.js";

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
 * Extract the Bearer token from the request; core decides whether it is valid.
 * @returns {Promise<object|null>} Token document or null
 */
async function resolveToken(req) {
  const authHeader = req.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  return resolveAccessToken(req.app.locals.mastodonCollections, authHeader.slice(7));
}
