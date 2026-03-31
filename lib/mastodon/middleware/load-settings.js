/**
 * Settings cache middleware for Mastodon API hot paths.
 *
 * Loads settings once per minute (not per request) and attaches
 * to req.app.locals.apSettings for all downstream handlers.
 */
import { getSettings } from "../../settings.js";

let cachedSettings = null;
let cacheExpiry = 0;
const CACHE_TTL = 60_000; // 1 minute

export async function loadSettingsMiddleware(req, res, next) {
  try {
    const now = Date.now();
    if (cachedSettings && now < cacheExpiry) {
      req.app.locals.apSettings = cachedSettings;
      return next();
    }

    const collections = req.app.locals.application?.collections;
    cachedSettings = await getSettings(collections);
    cacheExpiry = now + CACHE_TTL;
    req.app.locals.apSettings = cachedSettings;
    next();
  } catch {
    // On error, use defaults
    if (!cachedSettings) {
      const { DEFAULTS } = await import("../../settings.js");
      cachedSettings = { ...DEFAULTS };
    }
    req.app.locals.apSettings = cachedSettings;
    next();
  }
}
