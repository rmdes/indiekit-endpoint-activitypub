/**
 * Hashtag follow/unfollow controllers
 */

import { validateToken } from "../csrf.js";
import {
  followTag,
  unfollowTag,
  setGlobalFollow,
  removeGlobalFollow,
  getTagsPubActorUrl,
} from "../storage/followed-tags.js";

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

export function followTagGloballyController(mountPath, plugin) {
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

      const actorUrl = getTagsPubActorUrl(tag);

      // Send AP Follow activity via Fedify
      const result = await plugin.followActor(actorUrl);
      if (!result.ok) {
        const errorMsg = encodeURIComponent(result.error || "Follow failed");
        return response.redirect(
          `${mountPath}/admin/reader/tag?tag=${encodeURIComponent(tag)}&error=${errorMsg}`
        );
      }

      // Store global follow state
      const collections = {
        ap_followed_tags: application?.collections?.get("ap_followed_tags"),
      };
      await setGlobalFollow(collections, tag, actorUrl);

      return response.redirect(`${mountPath}/admin/reader/tag?tag=${encodeURIComponent(tag)}`);
    } catch (error) {
      next(error);
    }
  };
}

export function unfollowTagGloballyController(mountPath, plugin) {
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

      const actorUrl = getTagsPubActorUrl(tag);

      // Send AP Undo(Follow) activity via Fedify
      const result = await plugin.unfollowActor(actorUrl);
      if (!result.ok) {
        const errorMsg = encodeURIComponent(result.error || "Unfollow failed");
        return response.redirect(
          `${mountPath}/admin/reader/tag?tag=${encodeURIComponent(tag)}&error=${errorMsg}`
        );
      }

      // Remove global follow state
      const collections = {
        ap_followed_tags: application?.collections?.get("ap_followed_tags"),
      };
      await removeGlobalFollow(collections, tag);

      return response.redirect(`${mountPath}/admin/reader/tag?tag=${encodeURIComponent(tag)}`);
    } catch (error) {
      next(error);
    }
  };
}
