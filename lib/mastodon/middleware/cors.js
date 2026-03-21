/**
 * CORS middleware for Mastodon Client API routes.
 *
 * Mandatory for browser-based SPA clients like Phanpy that make
 * cross-origin requests. Without this, the browser's Same-Origin
 * Policy blocks all API calls.
 */

const ALLOWED_METHODS = "GET, HEAD, POST, PUT, DELETE, PATCH";
const ALLOWED_HEADERS = "Authorization, Content-Type, Idempotency-Key";
const EXPOSED_HEADERS = "Link";

export function corsMiddleware(req, res, next) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
}
