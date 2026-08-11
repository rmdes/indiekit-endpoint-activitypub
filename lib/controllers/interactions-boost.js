/**
 * Boost/Unboost interaction controllers.
 *
 * Transport layer only: CSRF, request validation, HTTP status codes. The
 * Announce / Undo(Announce) construction and delivery live in the shared helper
 * at lib/mastodon/helpers/interactions.js, which the Mastodon Client API also
 * calls — one implementation, two surfaces.
 *
 * This file previously carried its own copy, which delivered Undo(Announce) to
 * followers but NOT to the original post author — so a boost undone from the
 * reader stayed counted on the origin server forever (AP-D1). The helper has
 * always delivered both. Delegating closes the defect by structure.
 */

import { boostPost, unboostPost } from "../core/interactions.js";
import { validateToken } from "../csrf.js";
import {
  getFederation,
  getHandle,
  getPublicationUrl,
  isFederationReady,
} from "../federation-actions.js";

/**
 * Build the argument object the shared interaction helpers expect.
 *
 * @param {object} plugin - ActivityPub plugin instance
 * @param {object} request - Express request
 * @param {string} url - Target post URL
 */
function helperArgs(plugin, request, url) {
  const { application } = request.app.locals;

  return {
    targetUrl: url,
    federation: getFederation(plugin),
    handle: getHandle(plugin),
    publicationUrl: getPublicationUrl(plugin),
    collections: application?.collections,
    interactions: application?.collections?.get("ap_interactions"),
    loadRsaKey: () => plugin._loadRsaPrivateKey(),
  };
}

/**
 * Shared request guards. Returns an error response to send, or null to proceed.
 *
 * @param {object} request - Express request
 * @param {object} response - Express response
 * @param {object} plugin - ActivityPub plugin instance
 */
function guard(request, response, plugin) {
  if (!validateToken(request)) {
    return response.status(403).json({
      success: false,
      error: "Invalid CSRF token",
    });
  }

  if (!request.body?.url) {
    return response.status(400).json({
      success: false,
      error: "Missing post URL",
    });
  }

  if (!isFederationReady(plugin)) {
    return response.status(503).json({
      success: false,
      error: "Federation not initialized",
    });
  }

  return null;
}

/**
 * POST /admin/reader/boost — send an Announce activity to followers and to the
 * original post author.
 */
export function boostController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const blocked = guard(request, response, plugin);
      if (blocked) return blocked;

      const { url } = request.body;
      await boostPost(helperArgs(plugin, request, url));

      console.info(`[ActivityPub] Sent Announce (boost) for ${url}`);

      return response.json({
        success: true,
        type: "boost",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Boost failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Boost failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unboost — send an Undo(Announce) to followers AND to the
 * original post author, so the origin server decrements its boost count.
 */
export function unboostController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const blocked = guard(request, response, plugin);
      if (blocked) return blocked;

      const { url } = request.body;
      const { undone } = await unboostPost(helperArgs(plugin, request, url));

      if (!undone) {
        return response.status(404).json({
          success: false,
          error: "No boost found for this post",
        });
      }

      console.info(`[ActivityPub] Sent Undo(Announce) for ${url}`);

      return response.json({
        success: true,
        type: "unboost",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Unboost failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Unboost failed. Please try again later.",
      });
    }
  };
}
