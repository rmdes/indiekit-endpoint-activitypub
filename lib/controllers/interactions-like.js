/**
 * Like/Unlike interaction controllers.
 *
 * Transport layer only: CSRF, request validation, HTTP status codes. The
 * Like / Undo(Like) construction and delivery live in the shared helper at
 * lib/mastodon/helpers/interactions.js, which the Mastodon Client API also
 * calls — one implementation, two surfaces.
 */

import { likePost, unlikePost } from "../mastodon/helpers/interactions.js";
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
 * POST /admin/reader/like — send a Like activity to the post author.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance (for federation access)
 */
export function likeController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const blocked = guard(request, response, plugin);
      if (blocked) return blocked;

      const { url } = request.body;
      const { delivered } = await likePost(helperArgs(plugin, request, url));

      if (!delivered) {
        return response.status(404).json({
          success: false,
          error: "Could not resolve post author",
        });
      }

      console.info(`[ActivityPub] Sent Like for ${url}`);

      return response.json({
        success: true,
        type: "like",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Like failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Like failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unlike — send an Undo(Like) activity.
 */
export function unlikeController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const blocked = guard(request, response, plugin);
      if (blocked) return blocked;

      const { url } = request.body;
      const { undone } = await unlikePost(helperArgs(plugin, request, url));

      if (!undone) {
        return response.status(404).json({
          success: false,
          error: "No like found for this post",
        });
      }

      // An unresolvable author is not an error here — the local record is gone
      // either way, so the button state is correct. Matches prior behaviour.
      console.info(`[ActivityPub] Sent Undo(Like) for ${url}`);

      return response.json({
        success: true,
        type: "unlike",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Unlike failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Unlike failed. Please try again later.",
      });
    }
  };
}
