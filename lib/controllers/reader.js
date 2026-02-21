/**
 * Reader controller — shows timeline of posts from followed accounts.
 */

import { getTimelineItems } from "../storage/timeline.js";
import {
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
} from "../storage/notifications.js";
import { getToken } from "../csrf.js";
import {
  getMutedUrls,
  getMutedKeywords,
  getBlockedUrls,
} from "../storage/moderation.js";

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
      };

      // Query parameters
      const tab = request.query.tab || "all";
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
      };
      const [mutedUrls, mutedKeywords, blockedUrls] = await Promise.all([
        getMutedUrls(modCollections),
        getMutedKeywords(modCollections),
        getBlockedUrls(modCollections),
      ]);
      const hiddenUrls = new Set([...mutedUrls, ...blockedUrls]);

      if (hiddenUrls.size > 0 || mutedKeywords.length > 0) {
        items = items.filter((item) => {
          // Filter by author URL
          if (item.author?.url && hiddenUrls.has(item.author.url)) {
            return false;
          }

          // Filter by muted keywords in content
          if (mutedKeywords.length > 0 && item.content?.text) {
            const lower = item.content.text.toLowerCase();

            if (
              mutedKeywords.some((kw) => lower.includes(kw.toLowerCase()))
            ) {
              return false;
            }
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
      });
    } catch (error) {
      next(error);
    }
  };
}

export function notificationsController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_notifications: application?.collections?.get("ap_notifications"),
      };

      const before = request.query.before;
      const limit = Number.parseInt(request.query.limit || "20", 10);

      // Get notifications
      const result = await getNotifications(collections, { before, limit });

      // Get unread count before marking as read
      const unreadCount = await getUnreadNotificationCount(collections);

      // Mark all as read when page loads
      if (result.items.length > 0) {
        await markAllNotificationsRead(collections);
      }

      response.render("activitypub-notifications", {
        title: response.locals.__("activitypub.notifications.title"),
        items: result.items,
        before: result.before,
        unreadCount,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}
