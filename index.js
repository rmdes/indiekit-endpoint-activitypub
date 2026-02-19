import express from "express";

import { setupFederation } from "./lib/federation-setup.js";
import {
  createFedifyMiddleware,
} from "./lib/federation-bridge.js";
import {
  jf2ToActivityStreams,
  jf2ToAS2Activity,
} from "./lib/jf2-to-as2.js";
import { dashboardController } from "./lib/controllers/dashboard.js";
import { followersController } from "./lib/controllers/followers.js";
import { followingController } from "./lib/controllers/following.js";
import { activitiesController } from "./lib/controllers/activities.js";
import {
  migrateGetController,
  migratePostController,
  migrateImportController,
} from "./lib/controllers/migrate.js";
import {
  profileGetController,
  profilePostController,
} from "./lib/controllers/profile.js";

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
  activityRetentionDays: 90,
  storeRawActivities: false,
};

export default class ActivityPubEndpoint {
  name = "ActivityPub endpoint";

  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.options.actor = { ...defaults.actor, ...options.actor };
    this.mountPath = this.options.mountPath;

    this._publicationUrl = "";
    this._collections = {};
    this._federation = null;
    this._fedifyMiddleware = null;
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "activitypub.title",
      requiresDatabase: true,
    };
  }

  /**
   * WebFinger + NodeInfo discovery — mounted at /.well-known/
   * Fedify handles these automatically via federation.fetch().
   */
  get routesWellKnown() {
    const router = express.Router(); // eslint-disable-line new-cap
    const self = this;

    router.use((req, res, next) => {
      if (!self._fedifyMiddleware) return next();
      return self._fedifyMiddleware(req, res, next);
    });

    return router;
  }

  /**
   * Public federation routes — mounted at mountPath.
   * Fedify handles actor, inbox, outbox, followers, following.
   */
  get routesPublic() {
    const router = express.Router(); // eslint-disable-line new-cap
    const self = this;

    router.use((req, res, next) => {
      if (!self._fedifyMiddleware) return next();
      // Skip Fedify for admin UI routes — they're handled by the
      // authenticated `routes` getter, not the federation layer.
      if (req.path.startsWith("/admin")) return next();
      return self._fedifyMiddleware(req, res, next);
    });

    // Catch-all for federation paths that Fedify didn't handle (e.g. GET
    // on inbox). Without this, they fall through to Indiekit's auth
    // middleware and redirect to the login page.
    router.all("/users/:identifier/inbox", (req, res) => {
      res
        .status(405)
        .set("Allow", "POST")
        .type("application/activity+json")
        .json({
          error: "Method Not Allowed",
          message: "The inbox only accepts POST requests",
        });
    });
    router.all("/inbox", (req, res) => {
      res
        .status(405)
        .set("Allow", "POST")
        .type("application/activity+json")
        .json({
          error: "Method Not Allowed",
          message: "The shared inbox only accepts POST requests",
        });
    });

    return router;
  }

  /**
   * Authenticated admin routes — mounted at mountPath, behind IndieAuth.
   */
  get routes() {
    const router = express.Router(); // eslint-disable-line new-cap
    const mp = this.options.mountPath;

    router.get("/", dashboardController(mp));
    router.get("/admin/followers", followersController(mp));
    router.get("/admin/following", followingController(mp));
    router.get("/admin/activities", activitiesController(mp));
    router.get("/admin/profile", profileGetController(mp));
    router.post("/admin/profile", profilePostController(mp));
    router.get("/admin/migrate", migrateGetController(mp, this.options));
    router.post("/admin/migrate", migratePostController(mp, this.options));
    router.post(
      "/admin/migrate/import",
      migrateImportController(mp, this.options),
    );

    return router;
  }

  /**
   * Content negotiation — serves AS2 JSON for ActivityPub clients
   * requesting individual post URLs. Also handles NodeInfo data
   * at /nodeinfo/2.1 (delegated to Fedify).
   */
  get contentNegotiationRoutes() {
    const router = express.Router(); // eslint-disable-line new-cap
    const self = this;

    // Let Fedify handle NodeInfo data (/nodeinfo/2.1)
    // Only pass GET/HEAD requests — POST/PUT/DELETE must not go through
    // Fedify here, because fromExpressRequest() consumes the body stream,
    // breaking Express body-parsed routes downstream (e.g. admin forms).
    router.use((req, res, next) => {
      if (!self._fedifyMiddleware) return next();
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      return self._fedifyMiddleware(req, res, next);
    });

    // Content negotiation for AP clients on regular URLs
    router.get("{*path}", async (req, res, next) => {
      const accept = req.headers.accept || "";
      const isActivityPub =
        accept.includes("application/activity+json") ||
        accept.includes("application/ld+json");

      if (!isActivityPub) {
        return next();
      }

      try {
        // Root URL — redirect to Fedify actor
        if (req.path === "/") {
          const actorPath = `${self.options.mountPath}/users/${self.options.actor.handle}`;
          return res.redirect(actorPath);
        }

        // Post URLs — look up in database and convert to AS2
        const { application } = req.app.locals;
        const postsCollection = application?.collections?.get("posts");
        if (!postsCollection) {
          return next();
        }

        const requestUrl = `${self._publicationUrl}${req.path.slice(1)}`;
        const post = await postsCollection.findOne({
          "properties.url": requestUrl,
        });

        if (!post) {
          return next();
        }

        const actorUrl = self._getActorUrl();
        const activity = jf2ToActivityStreams(
          post.properties,
          actorUrl,
          self._publicationUrl,
        );

        const object = activity.object || activity;
        res.set("Content-Type", "application/activity+json");
        return res.json({
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
   * Syndicator — delivers posts to ActivityPub followers via Fedify.
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

      async syndicate(properties) {
        if (!self._federation) {
          return undefined;
        }

        try {
          const actorUrl = self._getActorUrl();
          const activity = jf2ToAS2Activity(
            properties,
            actorUrl,
            self._publicationUrl,
          );

          if (!activity) {
            return undefined;
          }

          const ctx = self._federation.createContext(
            new URL(self._publicationUrl),
            {},
          );

          await ctx.sendActivity(
            { identifier: self.options.actor.handle },
            "followers",
            activity,
          );

          return properties.url || undefined;
        } catch (error) {
          console.error("[ActivityPub] Syndication failed:", error.message);
          return undefined;
        }
      },
    };
  }

  /**
   * Build the full actor URL from config.
   * @returns {string}
   */
  _getActorUrl() {
    const base = this._publicationUrl.replace(/\/$/, "");
    return `${base}${this.options.mountPath}/users/${this.options.actor.handle}`;
  }

  init(Indiekit) {
    // Store publication URL for later use
    this._publicationUrl = Indiekit.publication?.me
      ? Indiekit.publication.me.endsWith("/")
        ? Indiekit.publication.me
        : `${Indiekit.publication.me}/`
      : "";

    // Register MongoDB collections
    Indiekit.addCollection("ap_followers");
    Indiekit.addCollection("ap_following");
    Indiekit.addCollection("ap_activities");
    Indiekit.addCollection("ap_keys");
    Indiekit.addCollection("ap_kv");
    Indiekit.addCollection("ap_profile");

    // Store collection references (posts resolved lazily)
    const indiekitCollections = Indiekit.collections;
    this._collections = {
      ap_followers: indiekitCollections.get("ap_followers"),
      ap_following: indiekitCollections.get("ap_following"),
      ap_activities: indiekitCollections.get("ap_activities"),
      ap_keys: indiekitCollections.get("ap_keys"),
      ap_kv: indiekitCollections.get("ap_kv"),
      ap_profile: indiekitCollections.get("ap_profile"),
      get posts() {
        return indiekitCollections.get("posts");
      },
      _publicationUrl: this._publicationUrl,
    };

    // TTL index for activity cleanup (MongoDB handles expiry automatically)
    const retentionDays = this.options.activityRetentionDays;
    if (retentionDays > 0) {
      this._collections.ap_activities.createIndex(
        { receivedAt: 1 },
        { expireAfterSeconds: retentionDays * 86_400 },
      );
    }

    // Seed actor profile from config on first run
    this._seedProfile().catch((error) => {
      console.warn("[ActivityPub] Profile seed failed:", error.message);
    });

    // Set up Fedify Federation instance
    const { federation } = setupFederation({
      collections: this._collections,
      mountPath: this.options.mountPath,
      handle: this.options.actor.handle,
      storeRawActivities: this.options.storeRawActivities,
    });

    this._federation = federation;
    this._fedifyMiddleware = createFedifyMiddleware(federation, () => ({}));

    // Register as endpoint (mounts routesPublic, routesWellKnown, routes)
    Indiekit.addEndpoint(this);

    // Content negotiation + NodeInfo — virtual endpoint at root
    Indiekit.addEndpoint({
      name: "ActivityPub content negotiation",
      mountPath: "/",
      routesPublic: this.contentNegotiationRoutes,
    });

    // Register syndicator (appears in post editing UI)
    Indiekit.addSyndicator(this.syndicator);
  }

  /**
   * Seed the ap_profile collection from config options on first run.
   * Only creates a profile if none exists — preserves UI edits.
   */
  async _seedProfile() {
    const { ap_profile } = this._collections;
    const existing = await ap_profile.findOne({});

    if (existing) {
      return;
    }

    const profile = {
      name: this.options.actor.name || this.options.actor.handle,
      summary: this.options.actor.summary || "",
      url: this._publicationUrl,
      icon: this.options.actor.icon || "",
      manuallyApprovesFollowers: false,
      createdAt: new Date().toISOString(),
    };

    // Only include alsoKnownAs if explicitly configured
    if (this.options.alsoKnownAs) {
      profile.alsoKnownAs = Array.isArray(this.options.alsoKnownAs)
        ? this.options.alsoKnownAs
        : [this.options.alsoKnownAs];
    }

    await ap_profile.insertOne(profile);
  }
}
