/**
 * Dashboard controller — shows follower/following counts and recent activity.
 */

import { getBatchRefollowStatus } from "../batch-refollow.js";

export function dashboardController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const followersCollection = application?.collections?.get("ap_followers");
      const followingCollection = application?.collections?.get("ap_following");
      const activitiesCollection =
        application?.collections?.get("ap_activities");

      const followerCount = followersCollection
        ? await followersCollection.countDocuments()
        : 0;
      const followingCount = followingCollection
        ? await followingCollection.countDocuments()
        : 0;

      const recentActivities = activitiesCollection
        ? await activitiesCollection
            .find()
            .sort({ receivedAt: -1 })
            .limit(10)
            .toArray()
        : [];

      // Get batch re-follow status for the progress section
      const refollowStatus = await getBatchRefollowStatus({
        ap_following: followingCollection,
        ap_kv: application?.collections?.get("ap_kv"),
      });

      response.render("activitypub-dashboard", {
        title: response.locals.__("activitypub.title"),
        followerCount,
        followingCount,
        recentActivities,
        refollowStatus,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}
