/**
 * Dashboard controller — shows follower/following counts and recent activity.
 */

import { getBatchRefollowStatus } from "../batch-refollow.js";
import { getAccountCounts, getRecentActivities } from "../core/profile.js";

export function dashboardController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const get = (name) => application?.collections?.get(name);
      const collections = {
        ap_followers: get("ap_followers"),
        ap_following: get("ap_following"),
        ap_activities: get("ap_activities"),
        ap_featured: get("ap_featured"),
        ap_featured_tags: get("ap_featured_tags"),
      };

      const [counts, recentActivities] = await Promise.all([
        getAccountCounts(collections),
        getRecentActivities(collections, { limit: 10 }),
      ]);

      // Get batch re-follow status for the progress section
      const refollowStatus = await getBatchRefollowStatus({
        ap_following: collections.ap_following,
      });

      response.render("activitypub-dashboard", {
        title: response.locals.__("activitypub.title"),
        followerCount: counts.followers,
        followingCount: counts.following,
        pinnedCount: counts.featured,
        tagCount: counts.featuredTags,
        recentActivities,
        refollowStatus,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}
