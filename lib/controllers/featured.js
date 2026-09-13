/**
 * Featured (pinned) posts controller — list, pin, and unpin posts.
 */
import {
  MAX_PINS,
  getFeaturedPins,
  getOwnPostByUrl,
  getOwnPosts,
  pinPost,
  unpinPost,
} from "../core/posts.js";

const postTitle = (props, fallback) =>
  props.name || props.content?.text?.slice(0, 80) || fallback;

export function featuredGetController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_featured: application?.collections?.get("ap_featured"),
        posts: application?.collections?.get("posts"),
      };

      const pinnedDocs = await getFeaturedPins(collections);

      // Enrich pinned posts with title/type from posts collection
      const pinned = [];
      for (const doc of pinnedDocs) {
        let title = doc.postUrl;
        let postType = "note";
        const post = await getOwnPostByUrl(collections, doc.postUrl);
        if (post?.properties) {
          title = postTitle(post.properties, doc.postUrl);
          postType = post.properties["post-type"] || "note";
        }
        pinned.push({ ...doc, title, postType });
      }

      // Get recent posts for the "pin" dropdown
      const recentPosts = await getOwnPosts(collections, { limit: 20 });

      const pinnedUrls = new Set(pinnedDocs.map((d) => d.postUrl));
      const availablePosts = recentPosts
        .filter((p) => p.properties?.url && !pinnedUrls.has(p.properties.url))
        .map((p) => ({
          url: p.properties.url,
          title: postTitle(p.properties, p.properties.url),
          postType: p.properties["post-type"] || "note",
        }));

      response.render("activitypub-featured", {
        title: response.locals.__("activitypub.featured") || "Pinned Posts",
        parent: { href: mountPath, text: response.locals.__("activitypub.title") },
        pinned,
        availablePosts,
        maxPins: MAX_PINS,
        canPin: pinned.length < MAX_PINS,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function featuredPinController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = { ap_featured: application?.collections?.get("ap_featured") };
      if (!collections.ap_featured) return response.status(500).send("No collection");

      const { postUrl } = request.body;
      if (!postUrl) return response.status(400).send("Missing postUrl");

      const result = await pinPost(collections, postUrl);
      if (!result.pinned) {
        return response.status(400).send("Maximum pins reached");
      }

      // Notify followers so they re-fetch the featured collection
      if (plugin?.broadcastActorUpdate) {
        plugin.broadcastActorUpdate().catch(() => {});
      }

      response.redirect(`${mountPath}/admin/featured`);
    } catch (error) {
      next(error);
    }
  };
}

export function featuredUnpinController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = { ap_featured: application?.collections?.get("ap_featured") };
      if (!collections.ap_featured) return response.status(500).send("No collection");

      const { postUrl } = request.body;
      if (!postUrl) return response.status(400).send("Missing postUrl");

      await unpinPost(collections, postUrl);

      // Notify followers so they re-fetch the featured collection
      if (plugin?.broadcastActorUpdate) {
        plugin.broadcastActorUpdate().catch(() => {});
      }

      response.redirect(`${mountPath}/admin/featured`);
    } catch (error) {
      next(error);
    }
  };
}
