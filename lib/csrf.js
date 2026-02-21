/**
 * Simple CSRF token generation and validation.
 * Tokens are stored in the Express session.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Get or generate a CSRF token for the current session.
 * @param {object} session - Express session object
 * @returns {string} CSRF token
 */
export function getToken(session) {
  if (!session._csrfToken) {
    session._csrfToken = randomBytes(32).toString("hex");
  }

  return session._csrfToken;
}

/**
 * Validate a CSRF token from a request.
 * Checks both the request body `_csrf` field and the `X-CSRF-Token` header.
 * @param {object} request - Express request object
 * @returns {boolean} Whether the token is valid
 */
export function validateToken(request) {
  const sessionToken = request.session?._csrfToken;

  if (!sessionToken) {
    return false;
  }

  const requestToken =
    request.body?._csrf || request.headers["x-csrf-token"];

  if (!requestToken) {
    return false;
  }

  if (sessionToken.length !== requestToken.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(sessionToken),
    Buffer.from(requestToken),
  );
}
