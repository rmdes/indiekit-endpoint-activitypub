/**
 * Admin controllers for the batch re-follow system.
 *
 * Provides pause, resume, and status endpoints for managing the
 * background batch processor from the admin UI.
 */

import {
  pauseBatchRefollow,
  resumeBatchRefollow,
  getBatchRefollowStatus,
} from "../batch-refollow.js";

/**
 * POST /admin/refollow/pause — pause the batch processor.
 *
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - Plugin instance (for federation/collections access)
 * @returns {Function} Express route handler
 */
export function refollowPauseController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_following: application.collections.get("ap_following"),
        ap_kv: application.collections.get("ap_kv"),
      };

      await pauseBatchRefollow(collections);

      response.json({ ok: true, status: "paused" });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/refollow/resume — resume the batch processor.
 *
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - Plugin instance
 * @returns {Function} Express route handler
 */
export function refollowResumeController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      await resumeBatchRefollow({
        federation: plugin._federation,
        collections: plugin._collections,
        handle: plugin.options.actor.handle,
        publicationUrl: plugin._publicationUrl,
      });

      response.json({ ok: true, status: "running" });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * GET /admin/refollow/status — get current batch processor status.
 *
 * @param {string} mountPath - Plugin mount path
 * @returns {Function} Express route handler
 */
export function refollowStatusController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_following: application.collections.get("ap_following"),
        ap_kv: application.collections.get("ap_kv"),
      };

      const status = await getBatchRefollowStatus(collections);
      response.json(status);
    } catch (error) {
      next(error);
    }
  };
}
