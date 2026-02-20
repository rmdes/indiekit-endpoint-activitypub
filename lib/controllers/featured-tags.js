/**
 * Featured tags controller — list, add, and remove featured hashtags.
 */

export function featuredTagsGetController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_featured_tags");

      const tags = collection
        ? await collection.find().sort({ addedAt: -1 }).toArray()
        : [];

      response.render("activitypub-featured-tags", {
        title:
          response.locals.__("activitypub.featuredTags") || "Featured Tags",
        tags,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function featuredTagsAddController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_featured_tags");
      if (!collection) return response.status(500).send("No collection");

      let { tag } = request.body;
      if (!tag) return response.status(400).send("Missing tag");

      // Normalize: strip leading # and lowercase
      tag = tag.replace(/^#/, "").toLowerCase().trim();
      if (!tag) return response.status(400).send("Invalid tag");

      await collection.updateOne(
        { tag },
        { $set: { tag, addedAt: new Date().toISOString() } },
        { upsert: true },
      );

      response.redirect(`${mountPath}/admin/tags`);
    } catch (error) {
      next(error);
    }
  };
}

export function featuredTagsRemoveController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_featured_tags");
      if (!collection) return response.status(500).send("No collection");

      const { tag } = request.body;
      if (!tag) return response.status(400).send("Missing tag");

      await collection.deleteOne({ tag });

      response.redirect(`${mountPath}/admin/tags`);
    } catch (error) {
      next(error);
    }
  };
}
