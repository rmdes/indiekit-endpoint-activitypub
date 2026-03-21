/**
 * Error handling middleware for Mastodon Client API routes.
 *
 * Ensures all errors return JSON in Mastodon's expected format
 * instead of HTML error pages that masto.js cannot parse.
 *
 * Standard format: { "error": "description" }
 * OAuth format:    { "error": "error_type", "error_description": "..." }
 */

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;

  // OAuth errors use RFC 6749 format
  if (err.oauthError) {
    return res.status(status).json({
      error: err.oauthError,
      error_description: err.message || "An error occurred",
    });
  }

  // Standard Mastodon error format
  res.status(status).json({
    error: err.message || "An unexpected error occurred",
  });
}

/**
 * 501 catch-all for unimplemented API endpoints.
 * Must be mounted AFTER all implemented routes.
 */
export function notImplementedHandler(req, res) {
  res.status(501).json({
    error: "Not implemented",
  });
}
