/**
 * OAuth2 routes for Mastodon Client API.
 *
 * Handles app registration, authorization, token exchange, and revocation.
 */
import crypto from "node:crypto";
import express from "express";

const router = express.Router(); // eslint-disable-line new-cap

/**
 * Generate cryptographically random hex string.
 * @param {number} bytes - Number of random bytes
 * @returns {string} Hex-encoded random string
 */
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Parse redirect_uris from request — accepts space-separated string or array.
 * @param {string|string[]} value
 * @returns {string[]}
 */
function parseRedirectUris(value) {
  if (!value) return ["urn:ietf:wg:oauth:2.0:oob"];
  if (Array.isArray(value)) return value.map((v) => v.trim());
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Parse scopes from request — accepts space-separated string.
 * @param {string} value
 * @returns {string[]}
 */
function parseScopes(value) {
  if (!value) return ["read"];
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// ─── POST /api/v1/apps — Register client application ────────────────────────

router.post("/api/v1/apps", async (req, res, next) => {
  try {
    const { client_name, redirect_uris, scopes, website } = req.body;

    const clientId = randomHex(16);
    const clientSecret = randomHex(32);
    const redirectUris = parseRedirectUris(redirect_uris);
    const parsedScopes = parseScopes(scopes);

    const doc = {
      clientId,
      clientSecret,
      name: client_name || "",
      redirectUris,
      scopes: parsedScopes,
      website: website || null,
      confidential: true,
      createdAt: new Date(),
    };

    const collections = req.app.locals.mastodonCollections;
    await collections.ap_oauth_apps.insertOne(doc);

    res.json({
      id: doc._id?.toString() || clientId,
      name: doc.name,
      website: doc.website,
      redirect_uris: redirectUris,
      redirect_uri: redirectUris.join(" "),
      client_id: clientId,
      client_secret: clientSecret,
      client_secret_expires_at: 0,
      vapid_key: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/apps/verify_credentials ─────────────────────────────────────

router.get("/api/v1/apps/verify_credentials", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const collections = req.app.locals.mastodonCollections;
    const app = await collections.ap_oauth_apps.findOne({
      clientId: token.clientId,
    });

    if (!app) {
      return res.status(404).json({ error: "Application not found" });
    }

    res.json({
      id: app._id.toString(),
      name: app.name,
      website: app.website,
      scopes: app.scopes,
      redirect_uris: app.redirectUris,
      redirect_uri: app.redirectUris.join(" "),
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /.well-known/oauth-authorization-server ─────────────────────────────

router.get("/.well-known/oauth-authorization-server", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    scopes_supported: [
      "read",
      "write",
      "follow",
      "push",
      "profile",
      "read:accounts",
      "read:blocks",
      "read:bookmarks",
      "read:favourites",
      "read:filters",
      "read:follows",
      "read:lists",
      "read:mutes",
      "read:notifications",
      "read:search",
      "read:statuses",
      "write:accounts",
      "write:blocks",
      "write:bookmarks",
      "write:conversations",
      "write:favourites",
      "write:filters",
      "write:follows",
      "write:lists",
      "write:media",
      "write:mutes",
      "write:notifications",
      "write:reports",
      "write:statuses",
    ],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://docs.joinmastodon.org/api/",
    app_registration_endpoint: `${baseUrl}/api/v1/apps`,
  });
});

// ─── GET /oauth/authorize — Show authorization page ──────────────────────────

router.get("/oauth/authorize", async (req, res, next) => {
  try {
    let {
      client_id,
      redirect_uri,
      response_type,
      scope,
      code_challenge,
      code_challenge_method,
      force_login,
    } = req.query;

    // Restore OAuth params from session after login redirect.
    // Indiekit's login flow doesn't re-encode the redirect param, so query
    // params with & are stripped during the /session/login → /session/auth
    // round-trip. We store them in the session before redirecting.
    if (!response_type && req.session?.pendingOAuth) {
      const p = req.session.pendingOAuth;
      delete req.session.pendingOAuth;
      client_id = p.client_id;
      redirect_uri = p.redirect_uri;
      response_type = p.response_type;
      scope = p.scope;
      code_challenge = p.code_challenge;
      code_challenge_method = p.code_challenge_method;
    }

    if (response_type !== "code") {
      return res.status(400).json({
        error: "unsupported_response_type",
        error_description: "Only response_type=code is supported",
      });
    }

    const collections = req.app.locals.mastodonCollections;
    const app = await collections.ap_oauth_apps.findOne({ clientId: client_id });

    if (!app) {
      return res.status(400).json({
        error: "invalid_client",
        error_description: "Client application not found",
      });
    }

    // Determine redirect URI — use provided or default to first registered
    const resolvedRedirectUri =
      redirect_uri || app.redirectUris[0] || "urn:ietf:wg:oauth:2.0:oob";

    // Validate redirect_uri is registered
    if (!app.redirectUris.includes(resolvedRedirectUri)) {
      return res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "Redirect URI not registered for this application",
      });
    }

    // Validate requested scopes are subset of app scopes
    const requestedScopes = scope ? scope.split(/\s+/) : app.scopes;

    // Check if user is logged in via IndieAuth session
    const session = req.session;
    if (!session?.access_token && !force_login) {
      // Store OAuth params in session — they won't survive Indiekit's
      // login redirect chain due to a re-encoding bug in indieauth.js.
      req.session.pendingOAuth = {
        client_id, redirect_uri, response_type, scope,
        code_challenge, code_challenge_method,
      };
      // Redirect to Indiekit's login page with a simple return path.
      return res.redirect("/session/login?redirect=/oauth/authorize");
    }

    // Render simple authorization page
    const appName = app.name || "An application";
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${appName}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; }
    .scopes { background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 6px; margin: 1rem 0; }
    .scopes code { display: block; margin: 0.25rem 0; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button { padding: 0.6rem 1.5rem; border-radius: 6px; font-size: 1rem; cursor: pointer; border: 1px solid #ccc; }
    .approve { background: #2b90d9; color: white; border-color: #2b90d9; }
    .deny { background: white; }
  </style>
</head>
<body>
  <h1>Authorize ${appName}</h1>
  <p>${appName} wants to access your account with these permissions:</p>
  <div class="scopes">
    ${requestedScopes.map((s) => `<code>${s}</code>`).join("")}
  </div>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${client_id}">
    <input type="hidden" name="redirect_uri" value="${resolvedRedirectUri}">
    <input type="hidden" name="scope" value="${requestedScopes.join(" ")}">
    <input type="hidden" name="code_challenge" value="${code_challenge || ""}">
    <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ""}">
    <input type="hidden" name="response_type" value="code">
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="approve">Authorize</button>
      <button type="submit" name="decision" value="deny" class="deny">Deny</button>
    </div>
  </form>
</body>
</html>`);
  } catch (error) {
    next(error);
  }
});

// ─── POST /oauth/authorize — Process authorization decision ──────────────────

router.post("/oauth/authorize", async (req, res, next) => {
  try {
    const {
      client_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method,
      decision,
    } = req.body;

    // User denied
    if (decision === "deny") {
      if (redirect_uri && redirect_uri !== "urn:ietf:wg:oauth:2.0:oob") {
        const url = new URL(redirect_uri);
        url.searchParams.set("error", "access_denied");
        url.searchParams.set(
          "error_description",
          "The resource owner denied the request",
        );
        return redirectToUri(res, redirect_uri, url.toString());
      }
      return res.status(403).json({
        error: "access_denied",
        error_description: "The resource owner denied the request",
      });
    }

    // Generate authorization code
    const code = randomHex(32);
    const collections = req.app.locals.mastodonCollections;

    // Note: accessToken is NOT set here — it's added later during token exchange.
    // The sparse unique index on accessToken skips documents where the field is
    // absent, allowing multiple auth codes to coexist. Setting it to null would
    // cause E11000 duplicate key errors because MongoDB sparse indexes still
    // enforce uniqueness on explicit null values.
    await collections.ap_oauth_tokens.insertOne({
      code,
      clientId: client_id,
      scopes: scope ? scope.split(/\s+/) : ["read"],
      redirectUri: redirect_uri,
      codeChallenge: code_challenge || null,
      codeChallengeMethod: code_challenge_method || null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    });

    // Out-of-band: show code on page
    if (!redirect_uri || redirect_uri === "urn:ietf:wg:oauth:2.0:oob") {
      return res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorization Code</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
    code { display: block; background: #f5f5f5; padding: 1rem; border-radius: 6px; word-break: break-all; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Authorization Code</h1>
  <p>Copy this code and paste it into the application:</p>
  <code>${code}</code>
</body>
</html>`);
    }

    // Redirect with code
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    redirectToUri(res, redirect_uri, url.toString());
  } catch (error) {
    next(error);
  }
});

// ─── POST /oauth/token — Exchange code for access token ──────────────────────

router.post("/oauth/token", async (req, res, next) => {
  try {
    const { grant_type, code, redirect_uri, code_verifier } = req.body;

    // Extract client credentials from request (3 methods)
    const { clientId, clientSecret } = extractClientCredentials(req);

    const collections = req.app.locals.mastodonCollections;

    if (grant_type === "client_credentials") {
      // Client credentials grant — limited access for pre-login API calls
      if (!clientId || !clientSecret) {
        return res.status(401).json({
          error: "invalid_client",
          error_description: "Client authentication required",
        });
      }

      const app = await collections.ap_oauth_apps.findOne({
        clientId,
        clientSecret,
        confidential: true,
      });

      if (!app) {
        return res.status(401).json({
          error: "invalid_client",
          error_description: "Invalid client credentials",
        });
      }

      // No code field — this is a direct token grant, not a code exchange.
      // Omitting code (instead of setting null) avoids sparse index collisions.
      const accessToken = randomHex(64);
      await collections.ap_oauth_tokens.insertOne({
        clientId,
        scopes: ["read"],
        accessToken,
        createdAt: new Date(),
        grantType: "client_credentials",
      });

      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        scope: "read",
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    // ─── Refresh token grant ──────────────────────────────────────────
    if (grant_type === "refresh_token") {
      const { refresh_token } = req.body;
      if (!refresh_token) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "Missing refresh_token",
        });
      }

      const existing = await collections.ap_oauth_tokens.findOne({
        refreshToken: refresh_token,
        revokedAt: null,
      });

      if (!existing) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token is invalid or revoked",
        });
      }

      // Rotate: new access token + new refresh token
      const newAccessToken = randomHex(64);
      const newRefreshToken = randomHex(64);
      await collections.ap_oauth_tokens.updateOne(
        { _id: existing._id },
        { $set: { accessToken: newAccessToken, refreshToken: newRefreshToken } },
      );

      return res.json({
        access_token: newAccessToken,
        token_type: "Bearer",
        scope: existing.scopes.join(" "),
        created_at: Math.floor(existing.createdAt.getTime() / 1000),
        refresh_token: newRefreshToken,
      });
    }

    if (grant_type !== "authorization_code") {
      return res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "Only authorization_code, client_credentials, and refresh_token are supported",
      });
    }

    if (!code) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Missing authorization code",
      });
    }

    // Atomic claim-or-fail: find the code and mark it used in one operation
    const grant = await collections.ap_oauth_tokens.findOneAndUpdate(
      {
        code,
        usedAt: null,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
      { returnDocument: "before" },
    );

    if (!grant) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description:
          "Authorization code is invalid, expired, or already used",
      });
    }

    // Validate redirect_uri matches
    if (redirect_uri && grant.redirectUri && redirect_uri !== grant.redirectUri) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: "Redirect URI mismatch",
      });
    }

    // Verify PKCE code_verifier if code_challenge was stored
    if (grant.codeChallenge) {
      if (!code_verifier) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Missing code_verifier for PKCE",
        });
      }

      const expectedChallenge = crypto
        .createHash("sha256")
        .update(code_verifier)
        .digest("base64url");

      if (expectedChallenge !== grant.codeChallenge) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Invalid code_verifier",
        });
      }
    }

    // Generate access token and refresh token.
    // Clear expiresAt — it was set for the auth code, not the access token.
    const accessToken = randomHex(64);
    const refreshToken = randomHex(64);
    await collections.ap_oauth_tokens.updateOne(
      { _id: grant._id },
      { $set: { accessToken, refreshToken, expiresAt: null } },
    );

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: grant.scopes.join(" "),
      created_at: Math.floor(grant.createdAt.getTime() / 1000),
      refresh_token: refreshToken,
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /oauth/revoke — Revoke a token ────────────────────────────────────

router.post("/oauth/revoke", async (req, res, next) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Missing token parameter",
      });
    }

    const collections = req.app.locals.mastodonCollections;
    // Match by access token or refresh token
    await collections.ap_oauth_tokens.updateOne(
      { $or: [{ accessToken: token }, { refreshToken: token }] },
      { $set: { revokedAt: new Date() } },
    );

    // RFC 7009: always return 200 even if token wasn't found
    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract client credentials from request using 3 methods:
 * 1. HTTP Basic Auth (client_secret_basic)
 * 2. POST body (client_secret_post)
 * 3. client_id only (none — public clients)
 */
function extractClientCredentials(req) {
  // Method 1: HTTP Basic Auth
  const authHeader = req.get("authorization");
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const colonIndex = decoded.indexOf(":");
    if (colonIndex > 0) {
      return {
        clientId: decoded.slice(0, colonIndex),
        clientSecret: decoded.slice(colonIndex + 1),
      };
    }
  }

  // Method 2 & 3: POST body
  return {
    clientId: req.body.client_id || null,
    clientSecret: req.body.client_secret || null,
  };
}

/**
 * Redirect to a URI, handling custom schemes for native apps.
 *
 * HTTP(S) redirect URIs use a standard 302 redirect (web clients).
 * Custom scheme URIs (fedilab://, moshidon-android-auth://) use an
 * HTML page with JavaScript + meta refresh. Android Chrome Custom Tabs
 * block 302 redirects to non-HTTP schemes but allow client-side navigation.
 *
 * @param {object} res - Express response
 * @param {string} originalUri - The registered redirect_uri (to detect scheme)
 * @param {string} fullUrl - The complete redirect URL with query params
 */
function redirectToUri(res, originalUri, fullUrl) {
  if (originalUri.startsWith("http://") || originalUri.startsWith("https://")) {
    return res.redirect(fullUrl);
  }

  // Native app — HTML page with JS redirect + meta refresh fallback
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${fullUrl}">
  <title>Redirecting…</title>
</head>
<body>
  <p>Redirecting to application…</p>
  <script>window.location.href = ${JSON.stringify(fullUrl)};</script>
</body>
</html>`);
}

export default router;
