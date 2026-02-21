/**
 * Profile controller — edit the ActivityPub actor profile.
 *
 * GET:  loads profile from ap_profile collection, renders form
 * POST: saves updated profile fields back to ap_profile
 */

const ACTOR_TYPES = ["Person", "Service", "Organization"];

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
        actorTypes: ACTOR_TYPES,
        result: null,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function profilePostController(mountPath, plugin) {
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
        actorType,
        manuallyApprovesFollowers,
        authorizedFetch,
      } = request.body;

      // Parse profile links (attachments) from form arrays
      const linkNames = [].concat(request.body["link_name[]"] || []);
      const linkValues = [].concat(request.body["link_value[]"] || []);
      const attachments = [];
      for (let i = 0; i < linkNames.length; i++) {
        const n = linkNames[i]?.trim();
        const v = linkValues[i]?.trim();
        if (n && v) {
          attachments.push({ name: n, value: v });
        }
      }

      const update = {
        $set: {
          name: name?.trim() || "",
          summary: summary?.trim() || "",
          url: url?.trim() || "",
          icon: icon?.trim() || "",
          image: image?.trim() || "",
          actorType: ACTOR_TYPES.includes(actorType) ? actorType : "Person",
          manuallyApprovesFollowers: manuallyApprovesFollowers === "true",
          authorizedFetch: authorizedFetch === "true",
          attachments,
          updatedAt: new Date().toISOString(),
        },
      };

      await profileCollection.updateOne({}, update, { upsert: true });

      // Send Update(Person) to followers so remote servers re-fetch the actor
      if (plugin?.broadcastActorUpdate) {
        plugin.broadcastActorUpdate().catch((error) => {
          console.warn("[ActivityPub] Profile update broadcast failed:", error.message);
        });
      }

      const profile = await profileCollection.findOne({});

      response.render("activitypub-profile", {
        title: response.locals.__("activitypub.profile.title"),
        mountPath,
        profile,
        actorTypes: ACTOR_TYPES,
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
