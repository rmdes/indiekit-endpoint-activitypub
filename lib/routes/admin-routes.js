/**
 * Authenticated admin UI routes for the ActivityPub endpoint.
 * Extracted from index.js's `get routes()` getter (Phase 2 god-entry split).
 * `self` is the ActivityPubEndpoint instance (passed through to controllers).
 */
import express from "express";

import { dashboardController } from "../controllers/dashboard.js";
import {
  readerController,
  notificationsController,
  markAllNotificationsReadController,
  clearAllNotificationsController,
  deleteNotificationController,
  composeController,
  submitComposeController,
  remoteProfileController,
  followController,
  unfollowController,
  postDetailController,
} from "../controllers/reader.js";
import {
  likeController,
  unlikeController,
  boostController,
  unboostController,
} from "../controllers/interactions.js";
import {
  muteController,
  unmuteController,
  blockController,
  unblockController,
  blockServerController,
  unblockServerController,
  moderationController,
  filterModeController,
} from "../controllers/moderation.js";
import { followersController } from "../controllers/followers.js";
import {
  approveFollowController,
  rejectFollowController,
} from "../controllers/follow-requests.js";
import { followingController } from "../controllers/following.js";
import { activitiesController } from "../controllers/activities.js";
import {
  migrateGetController,
  migratePostController,
  migrateImportController,
} from "../controllers/migrate.js";
import {
  profileGetController,
  profilePostController,
} from "../controllers/profile.js";
import {
  featuredGetController,
  featuredPinController,
  featuredUnpinController,
} from "../controllers/featured.js";
import {
  featuredTagsGetController,
  featuredTagsAddController,
  featuredTagsRemoveController,
} from "../controllers/featured-tags.js";
import { resolveController } from "../controllers/resolve.js";
import { tagTimelineController } from "../controllers/tag-timeline.js";
import { apiTimelineController, countNewController, markReadController } from "../controllers/api-timeline.js";
import {
  exploreController,
  exploreApiController,
  instanceSearchApiController,
  instanceCheckApiController,
  popularAccountsApiController,
} from "../controllers/explore.js";
import {
  followTagController,
  unfollowTagController,
  followTagGloballyController,
  unfollowTagGloballyController,
} from "../controllers/follow-tag.js";
import {
  listTabsController,
  addTabController,
  removeTabController,
  reorderTabsController,
} from "../controllers/tabs.js";
import { hashtagExploreApiController } from "../controllers/hashtag-explore.js";
import {
  messagesController,
  messageComposeController,
  submitMessageController,
  markAllMessagesReadController,
  clearAllMessagesController,
  deleteMessageController,
} from "../controllers/messages.js";
import { myProfileController } from "../controllers/my-profile.js";
import {
  refollowPauseController,
  refollowResumeController,
  refollowStatusController,
} from "../controllers/refollow.js";
import { deleteFederationController } from "../controllers/federation-delete.js";
import {
  federationMgmtController,
  rebroadcastController,
  viewApJsonController,
  broadcastActorUpdateController,
  lookupObjectController,
} from "../controllers/federation-mgmt.js";
import {
  settingsGetController,
  settingsPostController,
} from "../controllers/settings.js";

/**
 * Build the authenticated admin router.
 * @param {object} self - the ActivityPubEndpoint instance
 * @returns {import("express").Router}
 */
export function buildAdminRoutes(self) {
  const router = express.Router(); // eslint-disable-line new-cap
  const mp = self.options.mountPath;

  router.get("/", dashboardController(mp));
  router.get("/admin/reader", readerController(mp));
  router.get("/admin/reader/tag", tagTimelineController(mp));
  router.get("/admin/reader/api/timeline", apiTimelineController(mp));
  router.get("/admin/reader/api/timeline/count-new", countNewController());
  router.post("/admin/reader/api/timeline/mark-read", markReadController());
  router.get("/admin/reader/explore", exploreController(mp));
  router.get("/admin/reader/api/explore", exploreApiController(mp));
  router.get("/admin/reader/api/explore/hashtag", hashtagExploreApiController(mp));
  router.get("/admin/reader/api/instances", instanceSearchApiController(mp));
  router.get("/admin/reader/api/instance-check", instanceCheckApiController(mp));
  router.get("/admin/reader/api/popular-accounts", popularAccountsApiController(mp));
  router.get("/admin/reader/api/tabs", listTabsController(mp));
  router.post("/admin/reader/api/tabs", addTabController(mp));
  router.post("/admin/reader/api/tabs/remove", removeTabController(mp));
  router.patch("/admin/reader/api/tabs/reorder", reorderTabsController(mp));
  router.post("/admin/reader/follow-tag", followTagController(mp));
  router.post("/admin/reader/unfollow-tag", unfollowTagController(mp));
  router.post("/admin/reader/follow-tag-global", followTagGloballyController(mp, self));
  router.post("/admin/reader/unfollow-tag-global", unfollowTagGloballyController(mp, self));
  router.get("/admin/reader/notifications", notificationsController(mp));
  router.post("/admin/reader/notifications/mark-read", markAllNotificationsReadController(mp));
  router.post("/admin/reader/notifications/clear", clearAllNotificationsController(mp));
  router.post("/admin/reader/notifications/delete", deleteNotificationController(mp));
  router.get("/admin/reader/messages", messagesController(mp));
  router.get("/admin/reader/messages/compose", messageComposeController(mp, self));
  router.post("/admin/reader/messages/compose", submitMessageController(mp, self));
  router.post("/admin/reader/messages/mark-read", markAllMessagesReadController(mp));
  router.post("/admin/reader/messages/clear", clearAllMessagesController(mp));
  router.post("/admin/reader/messages/delete", deleteMessageController(mp));
  router.get("/admin/reader/compose", composeController(mp, self));
  router.post("/admin/reader/compose", submitComposeController(mp, self));
  router.post("/admin/reader/like", likeController(mp, self));
  router.post("/admin/reader/unlike", unlikeController(mp, self));
  router.post("/admin/reader/boost", boostController(mp, self));
  router.post("/admin/reader/unboost", unboostController(mp, self));
  router.get("/admin/reader/resolve", resolveController(mp, self));
  router.get("/admin/reader/profile", remoteProfileController(mp, self));
  router.get("/admin/reader/post", postDetailController(mp, self));
  router.post("/admin/reader/follow", followController(mp, self));
  router.post("/admin/reader/unfollow", unfollowController(mp, self));
  router.get("/admin/reader/moderation", moderationController(mp));
  router.post("/admin/reader/moderation/filter-mode", filterModeController(mp));
  router.post("/admin/reader/mute", muteController(mp, self));
  router.post("/admin/reader/unmute", unmuteController(mp, self));
  router.post("/admin/reader/block", blockController(mp, self));
  router.post("/admin/reader/unblock", unblockController(mp, self));
  router.post("/admin/reader/block-server", blockServerController(mp));
  router.post("/admin/reader/unblock-server", unblockServerController(mp));
  router.get("/admin/followers", followersController(mp));
  router.post("/admin/followers/approve", approveFollowController(mp, self));
  router.post("/admin/followers/reject", rejectFollowController(mp, self));
  router.get("/admin/following", followingController(mp));
  router.get("/admin/activities", activitiesController(mp));
  router.get("/admin/featured", featuredGetController(mp));
  router.post("/admin/featured/pin", featuredPinController(mp, self));
  router.post("/admin/featured/unpin", featuredUnpinController(mp, self));
  router.get("/admin/tags", featuredTagsGetController(mp));
  router.post("/admin/tags/add", featuredTagsAddController(mp, self));
  router.post("/admin/tags/remove", featuredTagsRemoveController(mp, self));
  router.get("/admin/profile", profileGetController(mp));
  router.post("/admin/profile", profilePostController(mp, self));
  router.get("/admin/my-profile", myProfileController(self));
  router.get("/admin/migrate", migrateGetController(mp, self.options));
  router.post("/admin/migrate", migratePostController(mp, self.options));
  router.post("/admin/migrate/import", migrateImportController(mp, self.options));
  router.post("/admin/refollow/pause", refollowPauseController(mp, self));
  router.post("/admin/refollow/resume", refollowResumeController(mp, self));
  router.get("/admin/refollow/status", refollowStatusController(mp));
  router.post("/admin/federation/delete", deleteFederationController(mp, self));
  router.get("/admin/federation", federationMgmtController(mp, self));
  router.post("/admin/federation/rebroadcast", rebroadcastController(mp, self));
  router.get("/admin/federation/ap-json", viewApJsonController(mp, self));
  router.post("/admin/federation/broadcast-actor", broadcastActorUpdateController(mp, self));
  router.get("/admin/federation/lookup", lookupObjectController(mp, self));

  // Settings
  router.get("/admin/settings", settingsGetController(mp));
  router.post("/admin/settings", settingsPostController(mp));

  return router;
}
