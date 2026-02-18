import express from "express";

import { handleWebFinger } from "./lib/webfinger.js";
import { buildActorDocument } from "./lib/actor.js";
import { getOrCreateKeyPair } from "./lib/keys.js";
import { jf2ToActivityStreams, resolvePostUrl } from "./lib/jf2-to-as2.js";
import { createFederationHandler } from "./lib/federation.js";
import { dashboardController } from "./lib/controllers/dashboard.js";
import { followersController } from "./lib/controllers/followers.js";
import { followingController } from "./lib/controllers/following.js";
import { activitiesController } from "./lib/controllers/activities.js";
import { migrateGetController, migratePostController } from "./lib/controllers/migrate.js";

const defaults = {
  mountPath: "/activitypub",
  actor: {
    handle: "rick",
    name: "",
    summary: "",
    icon: "",
  },
  checked: true,
  alsoKnownAs: "",
  activityRetentionDays: 90, // Auto-delete activities older than this (0 = keep forever)
  storeRawActivities: false, // Store full incoming JSON (enables debugging, costs storage)
};

export default class ActivityPubEndpoint {
  name = "ActivityPub endpoint";

  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.options.actor = { ...defaults.actor, ...options.actor };
    this.mountPath = this.options.mountPath;

    // Set at init time when we have access to Indiekit
    this._publicationUrl = "";
    this._actorUrl = "";
    this._collections = {};
    this._federationHandler = null;
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "activitypub.title",
      requiresDatabase: true,
    };
  }

  // filePath is set by Indiekit's plugin loader via require.resolve()

  /**
   * WebFinger routes — mounted at /.well-known/
   */
  get routesWellKnown() {
    const router = express.Router(); // eslint-disable-line new-cap
    const options = this.options;
    const self = this;

    router.get("/webfinger", (request, response) => {
      const resource = request.query.resource;
      if (!resource) {
        return response.status(400).json({ error: "Missing resource parameter" });
      }

      const result = handleWebFinger(resource, {
        handle: options.actor.handle,
        hostname: new URL(self._publicationUrl).hostname,
        actorUrl: self._actorUrl,
      });

      if (!result) {
        return response.status(404).json({ error: "Resource not found" });
      }

      response.set("Content-Type", "application/jrd+json");
      return response.json(result);
    });

    return router;
  }

  /**
   * Public federation routes — mounted at mountPath, unauthenticated
   */
  get routesPublic() {
    const router = express.Router(); // eslint-disable-line new-cap
    const self = this;

    // Actor document (fallback — primary is content negotiation on /)
    router.get("/actor", async (request, response) => {
      const actor = await self._getActorDocument();
      if (!actor) {
        return response.status(500).json({ error: "Actor not configured" });
      }
      response.set("Content-Type", "application/activity+json");
      return response.json(actor);
    });

    // Inbox — receive incoming activities
    router.post("/inbox", express.raw({ type: ["application/activity+json", "application/ld+json", "application/json"] }), async (request, response, next) => {
      try {
        if (self._federationHandler) {
          return await self._federationHandler.handleInbox(request, response);
        }
        return response.status(202).json({ status: "accepted" });
      } catch (error) {
        next(error);
      }
    });

    // Outbox — serve published posts as ActivityStreams
    router.get("/outbox", async (request, response, next) => {
      try {
        if (self._federationHandler) {
          return await self._federationHandler.handleOutbox(request, response);
        }
        response.set("Content-Type", "application/activity+json");
        return response.json({
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          totalItems: 0,
          orderedItems: [],
        });
      } catch (error) {
        next(error);
      }
    });

    // Followers collection
    router.get("/followers", async (request, response, next) => {
      try {
        if (self._federationHandler) {
          return await self._federationHandler.handleFollowers(request, response);
        }
        response.set("Content-Type", "application/activity+json");
        return response.json({
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          totalItems: 0,
          orderedItems: [],
        });
      } catch (error) {
        next(error);
      }
    });

    // Following collection
    router.get("/following", async (request, response, next) => {
      try {
        if (self._federationHandler) {
          return await self._federationHandler.handleFollowing(request, response);
        }
        response.set("Content-Type", "application/activity+json");
        return response.json({
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          totalItems: 0,
          orderedItems: [],
        });
      } catch (error) {
        next(error);
      }
    });

    return router;
  }

  /**
   * Authenticated admin routes — mounted at mountPath, behind IndieAuth
   */
  get routes() {
    const router = express.Router(); // eslint-disable-line new-cap
    const mp = this.options.mountPath;

    router.get("/", dashboardController(mp));
    router.get("/admin/followers", followersController(mp));
    router.get("/admin/following", followingController(mp));
    router.get("/admin/activities", activitiesController(mp));
    router.get("/admin/migrate", migrateGetController(mp));
    router.post("/admin/migrate", migratePostController(mp, this.options));

    return router;
  }

  /**
   * Content negotiation handler — serves AS2 JSON for ActivityPub clients
   * Registered as a separate endpoint with mountPath "/"
   */
  get contentNegotiationRoutes() {
    const router = express.Router(); // eslint-disable-line new-cap
    const self = this;

    router.get("{*path}", async (request, response, next) => {
      const accept = request.headers.accept || "";
      const isActivityPub =
        accept.includes("application/activity+json") ||
        accept.includes("application/ld+json");

      if (!isActivityPub) {
        return next();
      }

      try {
        // Root URL — serve actor document
        if (request.path === "/") {
          const actor = await self._getActorDocument();
          if (!actor) {
            return next();
          }
          response.set("Content-Type", "application/activity+json");
          return response.json(actor);
        }

        // Post URLs — look up in database and convert to AS2
        const { application } = request.app.locals;
        const postsCollection = application?.collections?.get("posts");
        if (!postsCollection) {
          return next();
        }

        // Try to find a post matching this URL path
        const requestUrl = `${self._publicationUrl}${request.path.slice(1)}`;
        const post = await postsCollection.findOne({
          "properties.url": requestUrl,
        });

        if (!post) {
          return next();
        }

        const activity = jf2ToActivityStreams(
          post.properties,
          self._actorUrl,
          self._publicationUrl,
        );

        // Return the object, not the wrapping Create activity
        const object = activity.object || activity;
        response.set("Content-Type", "application/activity+json");
        return response.json({
          "@context": [
            "https://www.w3.org/ns/activitystreams",
            "https://w3id.org/security/v1",
          ],
          ...object,
        });
      } catch {
        return next();
      }
    });

    return router;
  }

  /**
   * Build and cache the actor document
   */
  async _getActorDocument() {
    const keysCollection = this._collections.ap_keys;
    if (!keysCollection) {
      return null;
    }

    const keyPair = await getOrCreateKeyPair(keysCollection, this._actorUrl);
    return buildActorDocument({
      actorUrl: this._actorUrl,
      publicationUrl: this._publicationUrl,
      mountPath: this.options.mountPath,
      handle: this.options.actor.handle,
      name: this.options.actor.name,
      summary: this.options.actor.summary,
      icon: this.options.actor.icon,
      alsoKnownAs: this.options.alsoKnownAs,
      publicKeyPem: keyPair.publicKeyPem,
    });
  }

  /**
   * Syndicator — delivers posts to ActivityPub followers
   */
  get syndicator() {
    const self = this;
    return {
      name: "ActivityPub syndicator",
      options: { checked: self.options.checked },

      get info() {
        const hostname = self._publicationUrl
          ? new URL(self._publicationUrl).hostname
          : "example.com";
        return {
          checked: self.options.checked,
          name: `@${self.options.actor.handle}@${hostname}`,
          uid: self._publicationUrl || "https://example.com/",
          service: {
            name: "ActivityPub (Fediverse)",
            photo: "/assets/@rmdes-indiekit-endpoint-activitypub/icon.svg",
            url: self._publicationUrl || "https://example.com/",
          },
        };
      },

      async syndicate(properties, publication) {
        if (!self._federationHandler) {
          return undefined;
        }
        try {
          return await self._federationHandler.deliverToFollowers(
            properties,
            publication,
          );
        } catch (error) {
          console.error("[ActivityPub] Syndication failed:", error.message);
          return undefined;
        }
      },
    };
  }

  init(Indiekit) {
    // Store publication URL for later use
    this._publicationUrl = Indiekit.publication?.me
      ? Indiekit.publication.me.endsWith("/")
        ? Indiekit.publication.me
        : `${Indiekit.publication.me}/`
      : "";
    this._actorUrl = this._publicationUrl;

    // Register MongoDB collections
    Indiekit.addCollection("ap_followers");
    Indiekit.addCollection("ap_following");
    Indiekit.addCollection("ap_activities");
    Indiekit.addCollection("ap_keys");

    // Store collection references for later use
    this._collections = {
      ap_followers: Indiekit.collections.get("ap_followers"),
      ap_following: Indiekit.collections.get("ap_following"),
      ap_activities: Indiekit.collections.get("ap_activities"),
      ap_keys: Indiekit.collections.get("ap_keys"),
    };

    // Set up TTL index so ap_activities self-cleans (MongoDB handles expiry)
    const retentionDays = this.options.activityRetentionDays;
    if (retentionDays > 0) {
      this._collections.ap_activities.createIndex(
        { receivedAt: 1 },
        { expireAfterSeconds: retentionDays * 86_400 },
      );
    }

    // Initialize federation handler
    this._federationHandler = createFederationHandler({
      actorUrl: this._actorUrl,
      publicationUrl: this._publicationUrl,
      mountPath: this.options.mountPath,
      actorConfig: this.options.actor,
      alsoKnownAs: this.options.alsoKnownAs,
      collections: this._collections,
      storeRawActivities: this.options.storeRawActivities,
    });

    // Register as endpoint (adds routes)
    Indiekit.addEndpoint(this);

    // Register content negotiation handler as a virtual endpoint
    Indiekit.addEndpoint({
      name: "ActivityPub content negotiation",
      mountPath: "/",
      routesPublic: this.contentNegotiationRoutes,
    });

    // Register as syndicator (appears in post UI)
    Indiekit.addSyndicator(this.syndicator);
  }
}
