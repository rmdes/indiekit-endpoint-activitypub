/**
 * Mastodon Client API — main router.
 *
 * Combines all sub-routers, applies CORS and error handling middleware.
 * Mounted at "/" via Indiekit.addEndpoint() so Mastodon clients can access
 * /api/v1/*, /api/v2/*, /oauth/* at the domain root.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { corsMiddleware } from "./middleware/cors.js";
import { loadSettingsMiddleware } from "./middleware/load-settings.js";
import { tokenRequired, optionalToken } from "./middleware/token-required.js";
import { errorHandler, notImplementedHandler } from "./middleware/error-handler.js";

// Route modules
import oauthRouter from "./routes/oauth.js";
import instanceRouter from "./routes/instance.js";
import accountsRouter from "./routes/accounts.js";
import statusesRouter from "./routes/statuses.js";
import timelinesRouter from "./routes/timelines.js";
import notificationsRouter from "./routes/notifications.js";
import searchRouter from "./routes/search.js";
import mediaRouter from "./routes/media.js";
import filtersRouter from "./routes/filters.js";
import stubsRouter from "./routes/stubs.js";

// Rate limiters for different endpoint categories.
//
// CRITICAL: key per access-token (with a real-client-IP fallback). The default
// keyGenerator + `validate.trustProxy:false` keys on the SOCKET address — which
// behind Cloudron's proxy is a single constant, so EVERY client shared ONE
// 300/5min bucket (Phanpy + Phandroid + Fedilab + browser + bots). Once this
// session's fixes made more endpoints functional, clients made more requests
// and drained that shared bucket → "loads once then stops refreshing", and the
// in-memory store reset on restart → "works again after a container restart".
// Per-token keying isolates each app instance; the XFF-leftmost IP fallback
// covers unauthenticated calls (token exchange, app registration, public reads).
function clientRateKey(req) {
  const auth = req.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    return `tok:${auth.slice(7)}`;
  }
  const xff = req.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0].trim() : req.ip) || "unknown";
  return `ip:${ip}`;
}

// Disable startup validations: we intentionally use a custom keyGenerator
// (per-token, XFF-leftmost IP fallback) and know the proxy is trusted infra.
const rateLimitValidate = false;

const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 900, // per token — generous; Phanpy bursts on navigation
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientRateKey,
  message: { error: "Too many requests, please try again later" },
  validate: rateLimitValidate,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientRateKey,
  message: { error: "Too many authentication attempts" },
  validate: rateLimitValidate,
});

const appRegistrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientRateKey,
  message: { error: "Too many app registrations" },
  validate: rateLimitValidate,
});

/**
 * Create the combined Mastodon API router.
 *
 * @param {object} options
 * @param {object} options.collections - MongoDB collections object
 * @param {object} [options.pluginOptions] - Plugin options (handle, etc.)
 * @returns {import("express").Router} Express router
 */
export function createMastodonRouter({ collections, pluginOptions = {} }) {
  const router = express.Router(); // eslint-disable-line new-cap

  // ─── Body parsers ───────────────────────────────────────────────────────
  // Mastodon clients send JSON, form-urlencoded, and occasionally text/plain.
  // Note: multipart/form-data is handled globally by express-fileupload
  // (configured in Indiekit's express.js), so no multer needed here.
  router.use("/api", express.json());
  router.use("/api", express.urlencoded({ extended: true }));
  router.use("/oauth", express.json());
  router.use("/oauth", express.urlencoded({ extended: true }));

  // ─── CORS ───────────────────────────────────────────────────────────────
  router.use("/api", corsMiddleware);
  router.use("/oauth/token", corsMiddleware);

  // ─── Settings cache ────────────────────────────────────────────────────
  // Loads plugin settings once per minute, available as req.app.locals.apSettings
  router.use("/api", loadSettingsMiddleware);
  router.use("/oauth/revoke", corsMiddleware);
  router.use("/.well-known/oauth-authorization-server", corsMiddleware);

  // ─── Rate limiting ─────────────────────────────────────────────────────
  router.use("/api", apiLimiter);
  router.use("/oauth/token", authLimiter);
  router.use("/api/v1/apps", appRegistrationLimiter);

  // ─── Inject collections + plugin options into req ───────────────────────
  router.use("/api", (req, res, next) => {
    req.app.locals.mastodonCollections = collections;
    req.app.locals.mastodonPluginOptions = pluginOptions;
    next();
  });
  router.use("/oauth", (req, res, next) => {
    req.app.locals.mastodonCollections = collections;
    req.app.locals.mastodonPluginOptions = pluginOptions;
    next();
  });
  router.use("/.well-known/oauth-authorization-server", (req, res, next) => {
    req.app.locals.mastodonCollections = collections;
    req.app.locals.mastodonPluginOptions = pluginOptions;
    next();
  });

  // ─── Token resolution ───────────────────────────────────────────────────
  // Apply optional token resolution to all API routes so handlers can check
  // req.mastodonToken. Specific routes that require auth use tokenRequired.
  router.use("/api", optionalToken);

  // ─── OAuth routes (no token required for most) ──────────────────────────
  router.use(oauthRouter);

  // ─── Public API routes (no auth required) ───────────────────────────────
  router.use(instanceRouter);

  // ─── Authenticated API routes ───────────────────────────────────────────
  router.use(accountsRouter);
  router.use(statusesRouter);
  router.use(timelinesRouter);
  router.use(notificationsRouter);
  router.use(searchRouter);
  router.use(mediaRouter);
  router.use(filtersRouter);
  router.use(stubsRouter);

  // ─── Catch-all for unimplemented endpoints ──────────────────────────────
  // Express 5 path-to-regexp v8: use {*name} for wildcard
  router.all("/api/v1/{*rest}", notImplementedHandler);
  router.all("/api/v2/{*rest}", notImplementedHandler);

  // ─── Error handler ──────────────────────────────────────────────────────
  router.use("/api", errorHandler);
  router.use("/oauth", errorHandler);

  return router;
}
