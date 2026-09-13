/**
 * Remote profile controllers — view remote actors and follow/unfollow.
 */

import { getToken, validateToken } from "../csrf.js";
import { sanitizeContent } from "../timeline-store.js";
import { lookupWithSecurity } from "../lookup-helpers.js";
import { isFollowing as isFollowingActor } from "../core/profile.js";
import { getTimeline } from "../core/timeline.js";
import { isAccountBlocked, isAccountMuted } from "../core/moderation.js";

/**
 * GET /admin/reader/profile — Show remote actor profile.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
export function remoteProfileController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const actorUrl = request.query.url || request.query.handle;

      if (!actorUrl) {
        return response.status(400).render("error", {
          title: "Error",
          content: "Missing actor URL or handle",
        });
      }

      if (!plugin._federation) {
        return response.status(503).render("error", {
          title: "Error",
          content: "Federation not initialized",
        });
      }

      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      // Look up the remote actor (signed request for Authorized Fetch)
      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });
      let actor;

      try {
        actor = await lookupWithSecurity(ctx,new URL(actorUrl), { documentLoader });
      } catch {
        return response.status(404).render("error", {
          title: "Error",
          content: response.locals.__("activitypub.profile.remote.notFound"),
        });
      }

      if (!actor) {
        return response.status(404).render("error", {
          title: "Error",
          content: response.locals.__("activitypub.profile.remote.notFound"),
        });
      }

      // Extract actor info
      const name =
        actor.name?.toString() ||
        actor.preferredUsername?.toString() ||
        actorUrl;
      const actorHandle = actor.preferredUsername?.toString() || "";
      const bio = sanitizeContent(actor.summary?.toString() || "");
      let icon = "";
      let image = "";

      try {
        const iconObj = await actor.getIcon();
        icon = iconObj?.url?.href || "";
      } catch {
        // No icon
      }

      try {
        const imageObj = await actor.getImage();
        image = imageObj?.url?.href || "";
      } catch {
        // No header image
      }

      // Extract host for "View on {instance}"
      let instanceHost = "";

      try {
        instanceHost = new URL(actorUrl).hostname;
      } catch {
        // Invalid URL
      }

      const get = (name) => application?.collections?.get(name);
      const collections = {
        ap_following: get("ap_following"),
        ap_timeline: get("ap_timeline"),
        ap_muted: get("ap_muted"),
        ap_blocked: get("ap_blocked"),
      };

      // Check if we're following this actor
      const isFollowing = await isFollowingActor(collections, actorUrl);

      // Their posts from our timeline (only if following) — the same query the
      // Mastodon account statuses endpoint makes, so both surfaces agree.
      const posts = isFollowing && collections.ap_timeline
        ? (await getTimeline(collections, { authorUrl: actorUrl, limit: 20 })).items
        : [];

      // Check mute/block state
      const [isMuted, isBlocked] = await Promise.all([
        isAccountMuted(collections, actorUrl),
        isAccountBlocked(collections, actorUrl),
      ]);

      const csrfToken = getToken(request.session);

      response.render("activitypub-remote-profile", {
        title: name,
        readerParent: { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") },
        actorUrl,
        name,
        actorHandle,
        bio,
        icon,
        image,
        instanceHost,
        isFollowing,
        isMuted,
        isBlocked,
        posts,
        csrfToken,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/follow — Follow a remote actor.
 */
export function followController(mountPath, plugin) {
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
          error: "Missing actor URL",
        });
      }

      const result = await plugin.followActor(url);

      return response.json({
        success: result.ok,
        error: result.error || undefined,
      });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unfollow — Unfollow a remote actor.
 */
export function unfollowController(mountPath, plugin) {
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
          error: "Missing actor URL",
        });
      }

      const result = await plugin.unfollowActor(url);

      return response.json({
        success: result.ok,
        error: result.error || undefined,
      });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}
