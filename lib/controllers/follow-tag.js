/**
 * Hashtag follow/unfollow controllers
 */

import { validateToken } from "../csrf.js";
import { followTag, unfollowTag } from "../storage/followed-tags.js";

export function followTagController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;

      // CSRF validation
      if (!validateToken(request)) {
        return response.status(403).json({ error: "Invalid CSRF token" });
      }

      const tag = typeof request.body.tag === "string" ? request.body.tag.trim() : "";
      if (!tag) {
        return response.redirect(`${mountPath}/admin/reader`);
      }

      const collections = {
        ap_followed_tags: application?.collections?.get("ap_followed_tags"),
      };

      await followTag(collections, tag);

      return response.redirect(`${mountPath}/admin/reader/tag?tag=${encodeURIComponent(tag)}`);
    } catch (error) {
      next(error);
    }
  };
}

export function unfollowTagController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;

      // CSRF validation
      if (!validateToken(request)) {
        return response.status(403).json({ error: "Invalid CSRF token" });
      }

      const tag = typeof request.body.tag === "string" ? request.body.tag.trim() : "";
      if (!tag) {
        return response.redirect(`${mountPath}/admin/reader`);
      }

      const collections = {
        ap_followed_tags: application?.collections?.get("ap_followed_tags"),
      };

      await unfollowTag(collections, tag);

      return response.redirect(`${mountPath}/admin/reader/tag?tag=${encodeURIComponent(tag)}`);
    } catch (error) {
      next(error);
    }
  };
}
