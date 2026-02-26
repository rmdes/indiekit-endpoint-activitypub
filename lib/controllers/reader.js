/**
 * Reader controller — shows timeline of posts from followed accounts.
 */

import { getTimelineItems } from "../storage/timeline.js";
import {
  getNotifications,
  getUnreadNotificationCount,
  getNotificationCountsByType,
  markAllNotificationsRead,
  clearAllNotifications,
  deleteNotification,
} from "../storage/notifications.js";
import { getToken, validateToken } from "../csrf.js";
import {
  getMutedUrls,
  getMutedKeywords,
  getBlockedUrls,
  getFilterMode,
} from "../storage/moderation.js";
import { getFollowedTags } from "../storage/followed-tags.js";

// Re-export controllers from split modules for backward compatibility
export {
  composeController,
  submitComposeController,
} from "./compose.js";
export {
  remoteProfileController,
  followController,
  unfollowController,
} from "./profile.remote.js";
export { postDetailController } from "./post-detail.js";

export function readerController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
        ap_notifications: application?.collections?.get("ap_notifications"),
        ap_followed_tags: application?.collections?.get("ap_followed_tags"),
      };

      // Query parameters
      const tab = request.query.tab || "notes";
      const before = request.query.before;
      const after = request.query.after;
      const limit = Number.parseInt(request.query.limit || "20", 10);

      // Build query options
      const options = { before, after, limit };

      // Tab filtering
      if (tab === "notes") {
        options.type = "note";
        options.excludeReplies = true;
      } else if (tab === "articles") {
        options.type = "article";
      } else if (tab === "boosts") {
        options.type = "boost";
      }

      // Get timeline items
      const result = await getTimelineItems(collections, options);

      // Apply client-side filtering for tabs not supported by storage layer
      let items = result.items;
      if (tab === "replies") {
        items = items.filter((item) => item.inReplyTo);
      } else if (tab === "media") {
        items = items.filter(
          (item) =>
            (item.photo && item.photo.length > 0) ||
            (item.video && item.video.length > 0) ||
            (item.audio && item.audio.length > 0),
        );
      }

      // Apply moderation filters (muted actors, keywords, blocked actors)
      const modCollections = {
        ap_muted: application?.collections?.get("ap_muted"),
        ap_blocked: application?.collections?.get("ap_blocked"),
        ap_profile: application?.collections?.get("ap_profile"),
      };
      const [mutedUrls, mutedKeywords, blockedUrls, filterMode] =
        await Promise.all([
          getMutedUrls(modCollections),
          getMutedKeywords(modCollections),
          getBlockedUrls(modCollections),
          getFilterMode(modCollections),
        ]);
      const blockedSet = new Set(blockedUrls);
      const mutedSet = new Set(mutedUrls);

      if (blockedSet.size > 0 || mutedSet.size > 0 || mutedKeywords.length > 0) {
        items = items.filter((item) => {
          // Blocked actors are ALWAYS hidden
          if (item.author?.url && blockedSet.has(item.author.url)) {
            return false;
          }

          // Check muted actor
          const isMutedActor =
            item.author?.url && mutedSet.has(item.author.url);

          // Check muted keywords against content, title, and summary
          let matchedKeyword = null;
          if (mutedKeywords.length > 0) {
            const searchable = [
              item.content?.text,
              item.name,
              item.summary,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            if (searchable) {
              matchedKeyword = mutedKeywords.find((kw) =>
                searchable.includes(kw.toLowerCase()),
              );
            }
          }

          if (isMutedActor || matchedKeyword) {
            if (filterMode === "warn") {
              // Mark for content warning instead of hiding
              item._moderated = true;
              item._moderationReason = isMutedActor
                ? "muted_account"
                : "muted_keyword";
              if (matchedKeyword) {
                item._moderationKeyword = matchedKeyword;
              }
              return true;
            }
            return false;
          }

          return true;
        });
      }

      // Get unread notification count for badge
      const unreadCount = await getUnreadNotificationCount(collections);

      // Get interaction state for liked/boosted indicators
      // Interactions are keyed by canonical AP uid (new) or display url (legacy).
      // Query by both, normalize map keys to uid for template lookup.
      const interactionsCol =
        application?.collections?.get("ap_interactions");
      const interactionMap = {};

      if (interactionsCol) {
        const lookupUrls = new Set();
        const objectUrlToUid = new Map();

        for (const item of items) {
          const uid = item.uid;
          const displayUrl = item.url || item.originalUrl;

          if (uid) {
            lookupUrls.add(uid);
            objectUrlToUid.set(uid, uid);
          }

          if (displayUrl) {
            lookupUrls.add(displayUrl);
            objectUrlToUid.set(displayUrl, uid || displayUrl);
          }
        }

        if (lookupUrls.size > 0) {
          const interactions = await interactionsCol
            .find({ objectUrl: { $in: [...lookupUrls] } })
            .toArray();

          for (const interaction of interactions) {
            // Normalize to uid so template can look up by itemUid
            const key =
              objectUrlToUid.get(interaction.objectUrl) ||
              interaction.objectUrl;

            if (!interactionMap[key]) {
              interactionMap[key] = {};
            }

            interactionMap[key][interaction.type] = true;
          }
        }
      }

      // CSRF token for interaction forms
      const csrfToken = getToken(request.session);

      // Followed tags for sidebar
      let followedTags = [];
      try {
        followedTags = await getFollowedTags(collections);
      } catch {
        // Non-critical — collection may not exist yet
      }

      response.render("activitypub-reader", {
        title: response.locals.__("activitypub.reader.title"),
        items,
        tab,
        before: result.before,
        after: result.after,
        unreadCount,
        interactionMap,
        csrfToken,
        mountPath,
        followedTags,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function notificationsController(mountPath) {
  const validTabs = ["all", "reply", "like", "boost", "follow"];

  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_notifications: application?.collections?.get("ap_notifications"),
      };

      const tab = validTabs.includes(request.query.tab)
        ? request.query.tab
        : "reply";
      const before = request.query.before;
      const limit = Number.parseInt(request.query.limit || "20", 10);

      // Build query options with type filter
      const options = { before, limit };
      if (tab !== "all") {
        options.type = tab;
      }

      // Get filtered notifications + counts in parallel
      const [result, unreadCount, tabCounts] = await Promise.all([
        getNotifications(collections, options),
        getUnreadNotificationCount(collections),
        getNotificationCountsByType(collections),
      ]);

      // CSRF token for action forms
      const csrfToken = getToken(request.session);

      response.render("activitypub-notifications", {
        title: response.locals.__("activitypub.notifications.title"),
        items: result.items,
        before: result.before,
        tab,
        tabCounts,
        unreadCount,
        csrfToken,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/notifications/mark-read — mark all notifications as read.
 */
export function markAllNotificationsReadController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).redirect(`${mountPath}/admin/reader/notifications`);
      }

      const { application } = request.app.locals;
      const collections = {
        ap_notifications: application?.collections?.get("ap_notifications"),
      };

      await markAllNotificationsRead(collections);

      return response.redirect(`${mountPath}/admin/reader/notifications`);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/notifications/clear — delete all notifications.
 */
export function clearAllNotificationsController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).redirect(`${mountPath}/admin/reader/notifications`);
      }

      const { application } = request.app.locals;
      const collections = {
        ap_notifications: application?.collections?.get("ap_notifications"),
      };

      await clearAllNotifications(collections);

      return response.redirect(`${mountPath}/admin/reader/notifications`);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/notifications/delete — delete a single notification.
 */
export function deleteNotificationController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { uid } = request.body;

      if (!uid) {
        return response.status(400).json({
          success: false,
          error: "Missing notification UID",
        });
      }

      const { application } = request.app.locals;
      const collections = {
        ap_notifications: application?.collections?.get("ap_notifications"),
      };

      await deleteNotification(collections, uid);

      // Support both JSON (fetch) and form redirect
      if (request.headers.accept?.includes("application/json")) {
        return response.json({ success: true, uid });
      }

      return response.redirect(`${mountPath}/admin/reader/notifications`);
    } catch (error) {
      next(error);
    }
  };
}
