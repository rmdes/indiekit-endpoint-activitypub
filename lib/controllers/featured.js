/**
 * Featured (pinned) posts controller — list, pin, and unpin posts.
 */
const MAX_PINS = 5;

export function featuredGetController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const featuredCollection = application?.collections?.get("ap_featured");
      const postsCollection = application?.collections?.get("posts");

      const pinnedDocs = featuredCollection
        ? await featuredCollection.find().sort({ pinnedAt: -1 }).toArray()
        : [];

      // Enrich pinned posts with title/type from posts collection
      const pinned = [];
      for (const doc of pinnedDocs) {
        let title = doc.postUrl;
        let postType = "note";
        if (postsCollection) {
          const post = await postsCollection.findOne({
            "properties.url": doc.postUrl,
          });
          if (post?.properties) {
            title =
              post.properties.name ||
              post.properties.content?.text?.slice(0, 80) ||
              doc.postUrl;
            postType = post.properties["post-type"] || "note";
          }
        }
        pinned.push({ ...doc, title, postType });
      }

      // Get recent posts for the "pin" dropdown
      const recentPosts = postsCollection
        ? await postsCollection
            .find()
            .sort({ "properties.published": -1 })
            .limit(20)
            .toArray()
        : [];

      const pinnedUrls = new Set(pinnedDocs.map((d) => d.postUrl));
      const availablePosts = recentPosts
        .filter((p) => p.properties?.url && !pinnedUrls.has(p.properties.url))
        .map((p) => ({
          url: p.properties.url,
          title:
            p.properties.name ||
            p.properties.content?.text?.slice(0, 80) ||
            p.properties.url,
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
      const collection = application?.collections?.get("ap_featured");
      if (!collection) return response.status(500).send("No collection");

      const { postUrl } = request.body;
      if (!postUrl) return response.status(400).send("Missing postUrl");

      const count = await collection.countDocuments();
      if (count >= MAX_PINS) {
        return response.status(400).send("Maximum pins reached");
      }

      await collection.updateOne(
        { postUrl },
        { $set: { postUrl, pinnedAt: new Date().toISOString() } },
        { upsert: true },
      );

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
      const collection = application?.collections?.get("ap_featured");
      if (!collection) return response.status(500).send("No collection");

      const { postUrl } = request.body;
      if (!postUrl) return response.status(400).send("Missing postUrl");

      await collection.deleteOne({ postUrl });

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
