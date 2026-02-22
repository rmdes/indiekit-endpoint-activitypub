/**
 * Public profile controller — renders a standalone HTML profile page
 * for browsers visiting the actor URL (e.g. /activitypub/users/rick).
 *
 * Fedify handles ActivityPub clients via content negotiation; browsers
 * that send Accept: text/html fall through to this controller.
 */

export function publicProfileController(plugin) {
  return async (req, res, next) => {
    const identifier = req.params.identifier;

    // Only serve our own actor; unknown handles fall through to 404
    if (identifier !== plugin.options.actor.handle) {
      return next();
    }

    try {
      const { application } = req.app.locals;
      const collections = application.collections;

      const apProfile = collections.get("ap_profile");
      const apFollowers = collections.get("ap_followers");
      const apFollowing = collections.get("ap_following");
      const apFeatured = collections.get("ap_featured");
      const postsCollection = collections.get("posts");

      // Parallel queries for all profile data
      const [profile, followerCount, followingCount, postCount, featuredDocs, recentPosts] =
        await Promise.all([
          apProfile ? apProfile.findOne({}) : null,
          apFollowers ? apFollowers.countDocuments() : 0,
          apFollowing ? apFollowing.countDocuments() : 0,
          postsCollection ? postsCollection.countDocuments() : 0,
          apFeatured
            ? apFeatured.find().sort({ pinnedAt: -1 }).toArray()
            : [],
          postsCollection
            ? postsCollection
                .find()
                .sort({ "properties.published": -1 })
                .limit(20)
                .toArray()
            : [],
        ]);

      // Enrich pinned posts with title/type from posts collection
      const pinned = [];
      for (const doc of featuredDocs) {
        if (!postsCollection) break;
        const post = await postsCollection.findOne({
          "properties.url": doc.postUrl,
        });
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
