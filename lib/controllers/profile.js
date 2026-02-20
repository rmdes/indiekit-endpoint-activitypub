/**
 * Profile controller — edit the ActivityPub actor profile.
 *
 * GET:  loads profile from ap_profile collection, renders form
 * POST: saves updated profile fields back to ap_profile
 */

export function profileGetController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const profileCollection = application?.collections?.get("ap_profile");
      const profile = profileCollection
        ? (await profileCollection.findOne({})) || {}
        : {};

      response.render("activitypub-profile", {
        title: response.locals.__("activitypub.profile.title"),
        mountPath,
        profile,
        result: null,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function profilePostController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const profileCollection = application?.collections?.get("ap_profile");

      if (!profileCollection) {
        return next(new Error("ap_profile collection not available"));
      }

      const {
        name,
        summary,
        url,
        icon,
        image,
        manuallyApprovesFollowers,
        authorizedFetch,
      } = request.body;

      const update = {
        $set: {
          name: name?.trim() || "",
          summary: summary?.trim() || "",
          url: url?.trim() || "",
          icon: icon?.trim() || "",
          image: image?.trim() || "",
          manuallyApprovesFollowers: manuallyApprovesFollowers === "true",
          authorizedFetch: authorizedFetch === "true",
          updatedAt: new Date().toISOString(),
        },
      };

      await profileCollection.updateOne({}, update, { upsert: true });

      const profile = await profileCollection.findOne({});

      response.render("activitypub-profile", {
        title: response.locals.__("activitypub.profile.title"),
        mountPath,
        profile,
        result: {
          type: "success",
          text: response.locals.__("activitypub.profile.saved"),
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
