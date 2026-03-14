/**
 * POST /admin/federation/delete — Send Delete activity to all followers.
 * Removes a post from the fediverse after local deletion.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
import { validateToken } from "../csrf.js";

export function deleteFederationController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url } = request.body;
      if (!url) {
        return response.status(400).json({
          success: false,
          error: "Missing post URL",
        });
      }

      try {
        new URL(url);
      } catch {
        return response.status(400).json({
          success: false,
          error: "Invalid post URL",
        });
      }

      if (!plugin._federation) {
        return response.status(503).json({
          success: false,
          error: "Federation not initialized",
        });
      }

      await plugin.broadcastDelete(url);

      if (request.headers.accept?.includes("application/json")) {
        return response.json({ success: true, url });
      }

      const referrer = request.get("Referrer") || `${mountPath}/admin/activities`;
      return response.redirect(referrer);
    } catch (error) {
      next(error);
    }
  };
}
