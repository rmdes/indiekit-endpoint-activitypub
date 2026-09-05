/**
 * OAuth application and token storage.
 *
 * Security-sensitive, so the operations here are deliberately narrow: each one
 * expresses a complete step of the flow rather than exposing a general update.
 * `consumeAuthorizationCode` in particular is a single atomic
 * findOneAndUpdate — splitting it into read-then-write would open a window for
 * the same code to be redeemed twice.
 *
 * Worth having in core beyond the boundary rule: FEP-d8c2 is the C2S
 * authentication story, and a C2S adapter needs exactly these operations. The
 * server already serves RFC 8414 authorization-server metadata, so this is the
 * piece that carries over rather than being rebuilt.
 *
 * @module core/oauth
 */

/**
 * Register a client application.
 *
 * @param {object} collections
 * @param {object} app
 * @returns {Promise<object>} the stored document
 */
export async function createApp(collections, app) {
  await collections.ap_oauth_apps.insertOne(app);
  return app;
}

/**
 * Look up an application by any of its identifying fields.
 *
 * @param {object} collections
 * @param {object} filter
 * @returns {Promise<object|null>}
 */
export async function findApp(collections, filter) {
  if (!collections.ap_oauth_apps) return null;
  return collections.ap_oauth_apps.findOne(filter);
}

/**
 * Store an authorization code or access token.
 *
 * @param {object} collections
 * @param {object} token
 * @returns {Promise<object>}
 */
export async function createToken(collections, token) {
  await collections.ap_oauth_tokens.insertOne(token);
  return token;
}

/**
 * Look up a token document.
 *
 * @param {object} collections
 * @param {object} filter
 * @returns {Promise<object|null>}
 */
export async function findToken(collections, filter) {
  if (!collections.ap_oauth_tokens) return null;
  return collections.ap_oauth_tokens.findOne(filter);
}

/**
 * Redeem an authorization code, atomically.
 *
 * Returns the grant as it was BEFORE being marked used, and only if it was
 * unused, unrevoked and unexpired. A read-then-write pair here would let two
 * concurrent redemptions both see an unused code.
 *
 * @param {object} collections
 * @param {string} code
 * @returns {Promise<object|null>} the grant, or null if not redeemable
 */
export async function consumeAuthorizationCode(collections, code) {
  if (!code || !collections.ap_oauth_tokens) return null;

  return collections.ap_oauth_tokens.findOneAndUpdate(
    {
      code,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { returnDocument: "before" },
  );
}

/**
 * Apply an update to a token document.
 *
 * `unset` exists for one real case: rotating a refresh token must REMOVE
 * `expiresAt`, not set it to null. Access tokens here never expire, and a
 * lingering expiry inherited from the authorization code is what caused the
 * 10-minute 401 regression repaired at startup in index.js.
 *
 * @param {object} collections
 * @param {object} filter
 * @param {object} set - fields to set
 * @param {string[]} [unset] - field names to remove
 * @returns {Promise<number>} documents modified
 */
export async function updateToken(collections, filter, set, unset) {
  if (!collections.ap_oauth_tokens) return 0;

  const operation = {};
  if (set && Object.keys(set).length > 0) operation.$set = set;
  if (unset?.length) {
    operation.$unset = Object.fromEntries(unset.map((field) => [field, ""]));
  }

  if (Object.keys(operation).length === 0) return 0;

  const { modifiedCount } = await collections.ap_oauth_tokens.updateOne(
    filter,
    operation,
  );

  return modifiedCount;
}

/**
 * Revoke a token.
 *
 * @param {object} collections
 * @param {object} filter
 * @returns {Promise<number>}
 */
export async function revokeToken(collections, filter) {
  return updateToken(collections, filter, { revokedAt: new Date() });
}
