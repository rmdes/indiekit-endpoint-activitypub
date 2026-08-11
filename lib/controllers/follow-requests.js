/**
 * Follow request controllers — approve and reject pending follow requests
 * when manual follow approval is enabled.
 */

import { validateToken } from "../csrf.js";
import { approveFollow, rejectFollow } from "../core/follow-requests.js";

/**
 * POST /admin/followers/approve — Accept a pending follow request.
 */
export function approveFollowController(mountPath, plugin) {
  return followActionController(mountPath, plugin, approveFollow, "approved");
}

/**
 * POST /admin/reader/followers/reject — reject a pending follow request.
 */
export function rejectFollowController(mountPath, plugin) {
  return followActionController(mountPath, plugin, rejectFollow, "rejected");
}

/**
 * Shared transport wrapper. Both actions differ only in which core function
 * they call, so the CSRF/validation/response shape lives once.
 */
function followActionController(mountPath, plugin, action, pastTense) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { actorUrl } = request.body;

      if (!actorUrl) {
        return response.status(400).json({
          success: false,
          error: "Missing actor URL",
        });
      }

      const { application } = request.app.locals;
      const collections = {
        ap_pending_follows: application?.collections?.get("ap_pending_follows"),
        ap_followers: application?.collections?.get("ap_followers"),
        ap_activities: application?.collections?.get("ap_activities"),
      };

      const result = await action(collections, actorUrl, {
        federation: plugin._federation,
        handle: plugin.options.actor.handle,
        publicationUrl: plugin._publicationUrl,
      });

      if (!result.ok) {
        const status = result.error?.startsWith("No pending") ? 404 : 503;
        return response.status(status).json({
          success: false,
          error: result.error,
        });
      }

      if (request.headers.accept?.includes("application/json")) {
        return response.json({ success: true, actorUrl, action: pastTense });
      }

      return response.redirect(`${mountPath}/admin/followers`);
    } catch (error) {
      next(error);
    }
  };
}
