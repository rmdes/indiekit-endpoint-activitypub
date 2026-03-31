/**
 * Settings controller — admin page for ActivityPub plugin configuration.
 *
 * GET:  loads settings from ap_settings, renders form with defaults
 * POST: validates, saves settings, redirects with success message
 */
import { getSettings, saveSettings, DEFAULTS } from "../settings.js";
import { getToken, validateToken } from "../csrf.js";

export function settingsGetController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const settings = await getSettings(application.collections);

      response.render("activitypub-settings", {
        title: response.locals.__("activitypub.settings.title"),
        settings,
        defaults: DEFAULTS,
        mountPath,
        saved: request.query.saved === "true",
        csrfToken: getToken(request.session),
      });
    } catch (error) {
      next(error);
    }
  };
}

export function settingsPostController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).render("error", {
          title: "Error",
          content: "Invalid CSRF token",
        });
      }

      const { application } = request.app.locals;
      const body = request.body;

      const settings = {
        // Instance & Client API
        instanceLanguages: (body.instanceLanguages || "en")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        maxCharacters:
          parseInt(body.maxCharacters, 10) || DEFAULTS.maxCharacters,
        maxMediaAttachments:
          parseInt(body.maxMediaAttachments, 10) || DEFAULTS.maxMediaAttachments,
        defaultVisibility: body.defaultVisibility || DEFAULTS.defaultVisibility,
        defaultLanguage: (body.defaultLanguage || DEFAULTS.defaultLanguage).trim(),

        // Federation & Delivery
        timelineRetention: parseInt(body.timelineRetention, 10) || 0,
        notificationRetentionDays:
          parseInt(body.notificationRetentionDays, 10) || 0,
        activityRetentionDays:
          parseInt(body.activityRetentionDays, 10) || 0,
        replyChainDepth:
          parseInt(body.replyChainDepth, 10) || DEFAULTS.replyChainDepth,
        broadcastBatchSize:
          parseInt(body.broadcastBatchSize, 10) || DEFAULTS.broadcastBatchSize,
        broadcastBatchDelay:
          parseInt(body.broadcastBatchDelay, 10) || DEFAULTS.broadcastBatchDelay,
        parallelWorkers:
          parseInt(body.parallelWorkers, 10) || DEFAULTS.parallelWorkers,
        logLevel: body.logLevel || DEFAULTS.logLevel,

        // Migration
        refollowBatchSize:
          parseInt(body.refollowBatchSize, 10) || DEFAULTS.refollowBatchSize,
        refollowDelay:
          parseInt(body.refollowDelay, 10) || DEFAULTS.refollowDelay,
        refollowBatchDelay:
          parseInt(body.refollowBatchDelay, 10) || DEFAULTS.refollowBatchDelay,

        // Security
        refreshTokenTtlDays:
          parseInt(body.refreshTokenTtlDays, 10) || DEFAULTS.refreshTokenTtlDays,
      };

      await saveSettings(application.collections, settings);

      response.redirect(`${mountPath}/admin/settings?saved=true`);
    } catch (error) {
      next(error);
    }
  };
}
