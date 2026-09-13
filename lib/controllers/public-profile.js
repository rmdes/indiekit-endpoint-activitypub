/**
 * Public profile controller — renders a standalone HTML profile page
 * for browsers visiting the actor URL (e.g. /activitypub/users/rick).
 *
 * Fedify handles ActivityPub clients via content negotiation; browsers
 * that send Accept: text/html fall through to this controller.
 */

import { getAccountCounts, getProfile } from "../core/profile.js";
import {
  countOwnPosts,
  getFeaturedPins,
  getOwnPostByUrl,
  getOwnPosts,
} from "../core/posts.js";

export function publicProfileController(plugin) {
  return async (req, res, next) => {
    const identifier = req.params.identifier;

    // Only serve our own actor; unknown handles fall through to 404
    if (identifier !== plugin.options.actor.handle) {
      return next();
    }

    try {
      const { application } = req.app.locals;
      const get = (name) => application.collections.get(name);
      const collections = {
        ap_profile: get("ap_profile"),
        ap_followers: get("ap_followers"),
        ap_following: get("ap_following"),
        ap_featured: get("ap_featured"),
        posts: get("posts"),
      };

      // Parallel queries for all profile data
      const [profile, counts, postCount, featuredDocs, recentPosts] =
        await Promise.all([
          getProfile(collections),
          getAccountCounts(collections),
          countOwnPosts(collections),
          getFeaturedPins(collections),
          getOwnPosts(collections, { limit: 20 }),
        ]);
      const followerCount = counts.followers;
      const followingCount = counts.following;

      // Enrich pinned posts with title/type from posts collection
      const pinned = [];
      for (const doc of featuredDocs) {
        if (!collections.posts) break;
        const post = await getOwnPostByUrl(collections, doc.postUrl);
        if (post?.properties) {
          pinned.push({
            url: doc.postUrl,
            title:
              post.properties.name ||
              post.properties.content?.text?.slice(0, 120) ||
              doc.postUrl,
            type: post.properties["post-type"] || "note",
            published: post.properties.published,
          });
        }
      }

      const domain = new URL(plugin._publicationUrl).hostname;
      const handle = plugin.options.actor.handle;

      res.render("activitypub-public-profile", {
        profile: profile || {},
        handle,
        domain,
        fullHandle: `@${handle}@${domain}`,
        actorUrl: `${plugin._publicationUrl}activitypub/users/${handle}`,
        siteUrl: plugin._publicationUrl,
        followerCount,
        followingCount,
        postCount,
        pinned,
        recentPosts: recentPosts.map((p) => p.properties),
      });
    } catch (error) {
      next(error);
    }
  };
}
