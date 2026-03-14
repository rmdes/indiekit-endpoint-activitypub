/**
 * Reader controller — shows timeline of posts from followed accounts.
 */

import { getTimelineItems, countUnreadItems } from "../storage/timeline.js";
import {
  getNotifications,
  getUnreadNotificationCount,
  getNotificationCountsByType,
  markAllNotificationsRead,
  clearAllNotifications,
  deleteNotification,
} from "../storage/notifications.js";
import { getToken, validateToken } from "../csrf.js";
import { getFollowedTags } from "../storage/followed-tags.js";
import { postProcessItems, applyTabFilter, loadModerationData } from "../item-processing.js";

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

      // Unread filter
      const unread = request.query.unread === "1";

      // Build query options
      const options = { before, after, limit, unread };

      // Tab filtering at storage level
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

      // Tab filtering for types not supported by storage layer
      const tabFiltered = applyTabFilter(result.items, tab);

      // Load moderation data + interactions, apply shared pipeline
      const modCollections = {
        ap_muted: application?.collections?.get("ap_muted"),
        ap_blocked: application?.collections?.get("ap_blocked"),
        ap_profile: application?.collections?.get("ap_profile"),
      };
      const moderation = await loadModerationData(modCollections);

      const { items, interactionMap } = await postProcessItems(tabFiltered, {
        moderation,
        interactionsCol: application?.collections?.get("ap_interactions"),
      });

      // Get unread notification count for badge + unread timeline count for toggle
      const [unreadCount, unreadTimelineCount] = await Promise.all([
        getUnreadNotificationCount(collections),
        countUnreadItems(collections),
      ]);

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
        readerParent: { href: mountPath, text: response.locals.__("activitypub.title") },
        items,
        tab,
        unread,
        before: result.before,
        after: result.after,
        unreadCount,
        unreadTimelineCount,
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
  const validTabs = ["all", "reply", "like", "boost", "follow", "dm", "report"];

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
        readerParent: { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") },
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
