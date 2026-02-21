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
import {
  readerController,
  notificationsController,
  composeController,
  submitComposeController,
  remoteProfileController,
  followController,
  unfollowController,
} from "./lib/controllers/reader.js";
import {
  likeController,
  unlikeController,
  boostController,
  unboostController,
} from "./lib/controllers/interactions.js";
import {
  muteController,
  unmuteController,
  blockController,
  unblockController,
  moderationController,
} from "./lib/controllers/moderation.js";
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
import {
  featuredGetController,
  featuredPinController,
  featuredUnpinController,
} from "./lib/controllers/featured.js";
import {
  featuredTagsGetController,
  featuredTagsAddController,
  featuredTagsRemoveController,
} from "./lib/controllers/featured-tags.js";
import {
  refollowPauseController,
  refollowResumeController,
  refollowStatusController,
} from "./lib/controllers/refollow.js";
import { startBatchRefollow } from "./lib/batch-refollow.js";
import { logActivity } from "./lib/activity-log.js";
import { scheduleCleanup } from "./lib/timeline-cleanup.js";

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
  redisUrl: "",
  parallelWorkers: 5,
  actorType: "Person",
  timelineRetention: 1000,
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
      href: `${this.options.mountPath}/admin/reader`,
      text: "activitypub.reader.title",
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
    router.get("/admin/reader", readerController(mp));
    router.get("/admin/reader/notifications", notificationsController(mp));
    router.get("/admin/reader/compose", composeController(mp, this));
    router.post("/admin/reader/compose", submitComposeController(mp, this));
    router.post("/admin/reader/like", likeController(mp, this));
    router.post("/admin/reader/unlike", unlikeController(mp, this));
    router.post("/admin/reader/boost", boostController(mp, this));
    router.post("/admin/reader/unboost", unboostController(mp, this));
    router.get("/admin/reader/profile", remoteProfileController(mp, this));
    router.post("/admin/reader/follow", followController(mp, this));
    router.post("/admin/reader/unfollow", unfollowController(mp, this));
    router.get("/admin/reader/moderation", moderationController(mp));
    router.post("/admin/reader/mute", muteController(mp, this));
    router.post("/admin/reader/unmute", unmuteController(mp, this));
    router.post("/admin/reader/block", blockController(mp, this));
    router.post("/admin/reader/unblock", unblockController(mp, this));
    router.get("/admin/followers", followersController(mp));
    router.get("/admin/following", followingController(mp));
    router.get("/admin/activities", activitiesController(mp));
    router.get("/admin/featured", featuredGetController(mp));
    router.post("/admin/featured/pin", featuredPinController(mp));
    router.post("/admin/featured/unpin", featuredUnpinController(mp));
    router.get("/admin/tags", featuredTagsGetController(mp));
    router.post("/admin/tags/add", featuredTagsAddController(mp));
    router.post("/admin/tags/remove", featuredTagsRemoveController(mp));
    router.get("/admin/profile", profileGetController(mp));
    router.post("/admin/profile", profilePostController(mp));
    router.get("/admin/migrate", migrateGetController(mp, this.options));
    router.post("/admin/migrate", migratePostController(mp, this.options));
    router.post(
      "/admin/migrate/import",
      migrateImportController(mp, this.options),
    );
    router.post("/admin/refollow/pause", refollowPauseController(mp, this));
    router.post("/admin/refollow/resume", refollowResumeController(mp, this));
    router.get("/admin/refollow/status", refollowStatusController(mp));

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
      // Only delegate to Fedify for NodeInfo data endpoint (/nodeinfo/2.1).
      // All other paths in this root-mounted router are handled by the
      // content negotiation catch-all below. Passing arbitrary paths like
      // /notes/... to Fedify causes harmless but noisy 404 warnings.
      if (!req.path.startsWith("/nodeinfo/")) return next();
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
          const handle = self.options.actor.handle;

          const ctx = self._federation.createContext(
            new URL(self._publicationUrl),
            { handle, publicationUrl: self._publicationUrl },
          );

          // For replies, resolve the original post author for proper
          // addressing (CC) and direct inbox delivery
          let replyToActor = null;
          if (properties["in-reply-to"]) {
            try {
              const remoteObject = await ctx.lookupObject(
                new URL(properties["in-reply-to"]),
              );
              if (remoteObject && typeof remoteObject.getAttributedTo === "function") {
                const author = await remoteObject.getAttributedTo();
                const authorActor = Array.isArray(author) ? author[0] : author;
                if (authorActor?.id) {
                  replyToActor = {
                    url: authorActor.id.href,
                    handle: authorActor.preferredUsername || null,
                    recipient: authorActor,
                  };
                  console.info(
                    `[ActivityPub] Reply to ${properties["in-reply-to"]} — resolved author: ${replyToActor.url}`,
                  );
                }
              }
            } catch (error) {
              console.warn(
                `[ActivityPub] Could not resolve reply-to author for ${properties["in-reply-to"]}: ${error.message}`,
              );
            }
          }

          const activity = jf2ToAS2Activity(
            properties,
            actorUrl,
            self._publicationUrl,
            {
              replyToActorUrl: replyToActor?.url,
              replyToActorHandle: replyToActor?.handle,
            },
          );

          if (!activity) {
            await logActivity(self._collections.ap_activities, {
              direction: "outbound",
              type: "Syndicate",
              actorUrl: self._publicationUrl,
              objectUrl: properties.url,
              summary: `Syndication skipped: could not convert post to AS2`,
            });
            return undefined;
          }

          // Count followers for logging
          const followerCount =
            await self._collections.ap_followers.countDocuments();

          console.info(
            `[ActivityPub] Sending ${activity.constructor?.name || "activity"} for ${properties.url} to ${followerCount} followers`,
          );

          // Send to followers via shared inboxes with collection sync (FEP-8fcf)
          await ctx.sendActivity(
            { identifier: handle },
            "followers",
            activity,
            {
              preferSharedInbox: true,
              syncCollection: true,
              orderingKey: properties.url,
            },
          );

          // For replies, also deliver to the original post author's inbox
          // so their server can thread the reply under the original post
          if (replyToActor?.recipient) {
            try {
              await ctx.sendActivity(
                { identifier: handle },
                replyToActor.recipient,
                activity,
                { orderingKey: properties.url },
              );
              console.info(
                `[ActivityPub] Reply delivered to author: ${replyToActor.url}`,
              );
            } catch (error) {
              console.warn(
                `[ActivityPub] Failed to deliver reply to ${replyToActor.url}: ${error.message}`,
              );
            }
          }

          // Determine activity type name
          const typeName =
            activity.constructor?.name || "Create";
          const replyNote = replyToActor
            ? ` (reply to ${replyToActor.url})`
            : "";

          await logActivity(self._collections.ap_activities, {
            direction: "outbound",
            type: typeName,
            actorUrl: self._publicationUrl,
            objectUrl: properties.url,
            targetUrl: replyToActor?.url || undefined,
            summary: `Sent ${typeName} for ${properties.url} to ${followerCount} followers${replyNote}`,
          });

          console.info(
            `[ActivityPub] Syndication queued: ${typeName} for ${properties.url}${replyNote}`,
          );

          return properties.url || undefined;
        } catch (error) {
          console.error("[ActivityPub] Syndication failed:", error.message);
          await logActivity(self._collections.ap_activities, {
            direction: "outbound",
            type: "Syndicate",
            actorUrl: self._publicationUrl,
            objectUrl: properties.url,
            summary: `Syndication failed: ${error.message}`,
          }).catch(() => {});
          return undefined;
        }
      },
    };
  }

  /**
   * Send a Follow activity to a remote actor and store in ap_following.
   * @param {string} actorUrl - The remote actor's URL
   * @param {object} [actorInfo] - Optional pre-fetched actor info
   * @param {string} [actorInfo.name] - Actor display name
   * @param {string} [actorInfo.handle] - Actor handle
   * @param {string} [actorInfo.photo] - Actor avatar URL
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async followActor(actorUrl, actorInfo = {}) {
    if (!this._federation) {
      return { ok: false, error: "Federation not initialized" };
    }

    try {
      const { Follow } = await import("@fedify/fedify");
      const handle = this.options.actor.handle;
      const ctx = this._federation.createContext(
        new URL(this._publicationUrl),
        { handle, publicationUrl: this._publicationUrl },
      );

      // Resolve the remote actor to get their inbox
      const remoteActor = await ctx.lookupObject(actorUrl);
      if (!remoteActor) {
        return { ok: false, error: "Could not resolve remote actor" };
      }

      // Send Follow activity
      const follow = new Follow({
        actor: ctx.getActorUri(handle),
        object: new URL(actorUrl),
      });

      await ctx.sendActivity({ identifier: handle }, remoteActor, follow, {
        orderingKey: actorUrl,
      });

      // Store in ap_following
      const name =
        actorInfo.name ||
        remoteActor.name?.toString() ||
        remoteActor.preferredUsername?.toString() ||
        actorUrl;
      const actorHandle =
        actorInfo.handle ||
        remoteActor.preferredUsername?.toString() ||
        "";
      const avatar =
        actorInfo.photo ||
        (remoteActor.icon
          ? (await remoteActor.icon)?.url?.href || ""
          : "");
      const inbox = remoteActor.inbox?.id?.href || "";
      const sharedInbox = remoteActor.endpoints?.sharedInbox?.href || "";

      await this._collections.ap_following.updateOne(
        { actorUrl },
        {
          $set: {
            actorUrl,
            handle: actorHandle,
            name,
            avatar,
            inbox,
            sharedInbox,
            followedAt: new Date().toISOString(),
            source: "reader",
          },
        },
        { upsert: true },
      );

      console.info(`[ActivityPub] Sent Follow to ${actorUrl}`);

      await logActivity(this._collections.ap_activities, {
        direction: "outbound",
        type: "Follow",
        actorUrl: this._publicationUrl,
        objectUrl: actorUrl,
        actorName: name,
        summary: `Sent Follow to ${name} (${actorUrl})`,
      });

      return { ok: true };
    } catch (error) {
      console.error(`[ActivityPub] Follow failed for ${actorUrl}:`, error.message);

      await logActivity(this._collections.ap_activities, {
        direction: "outbound",
        type: "Follow",
        actorUrl: this._publicationUrl,
        objectUrl: actorUrl,
        summary: `Follow failed for ${actorUrl}: ${error.message}`,
      }).catch(() => {});

      return { ok: false, error: error.message };
    }
  }

  /**
   * Send an Undo(Follow) activity and remove from ap_following.
   * @param {string} actorUrl - The remote actor's URL
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async unfollowActor(actorUrl) {
    if (!this._federation) {
      return { ok: false, error: "Federation not initialized" };
    }

    try {
      const { Follow, Undo } = await import("@fedify/fedify");
      const handle = this.options.actor.handle;
      const ctx = this._federation.createContext(
        new URL(this._publicationUrl),
        { handle, publicationUrl: this._publicationUrl },
      );

      const remoteActor = await ctx.lookupObject(actorUrl);
      if (!remoteActor) {
        // Even if we can't resolve, remove locally
        await this._collections.ap_following.deleteOne({ actorUrl });

        await logActivity(this._collections.ap_activities, {
          direction: "outbound",
          type: "Undo(Follow)",
          actorUrl: this._publicationUrl,
          objectUrl: actorUrl,
          summary: `Removed ${actorUrl} locally (could not resolve remote actor)`,
        }).catch(() => {});

        return { ok: true };
      }

      const follow = new Follow({
        actor: ctx.getActorUri(handle),
        object: new URL(actorUrl),
      });

      const undo = new Undo({
        actor: ctx.getActorUri(handle),
        object: follow,
      });

      await ctx.sendActivity({ identifier: handle }, remoteActor, undo, {
        orderingKey: actorUrl,
      });
      await this._collections.ap_following.deleteOne({ actorUrl });

      console.info(`[ActivityPub] Sent Undo(Follow) to ${actorUrl}`);

      await logActivity(this._collections.ap_activities, {
        direction: "outbound",
        type: "Undo(Follow)",
        actorUrl: this._publicationUrl,
        objectUrl: actorUrl,
        summary: `Sent Undo(Follow) to ${actorUrl}`,
      });

      return { ok: true };
    } catch (error) {
      console.error(`[ActivityPub] Unfollow failed for ${actorUrl}:`, error.message);

      await logActivity(this._collections.ap_activities, {
        direction: "outbound",
        type: "Undo(Follow)",
        actorUrl: this._publicationUrl,
        objectUrl: actorUrl,
        summary: `Unfollow failed for ${actorUrl}: ${error.message}`,
      }).catch(() => {});

      // Remove locally even if remote delivery fails
      await this._collections.ap_following.deleteOne({ actorUrl }).catch(() => {});
      return { ok: false, error: error.message };
    }
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
    Indiekit.addCollection("ap_featured");
    Indiekit.addCollection("ap_featured_tags");
    // Reader collections
    Indiekit.addCollection("ap_timeline");
    Indiekit.addCollection("ap_notifications");
    Indiekit.addCollection("ap_muted");
    Indiekit.addCollection("ap_blocked");
    Indiekit.addCollection("ap_interactions");

    // Store collection references (posts resolved lazily)
    const indiekitCollections = Indiekit.collections;
    this._collections = {
      ap_followers: indiekitCollections.get("ap_followers"),
      ap_following: indiekitCollections.get("ap_following"),
      ap_activities: indiekitCollections.get("ap_activities"),
      ap_keys: indiekitCollections.get("ap_keys"),
      ap_kv: indiekitCollections.get("ap_kv"),
      ap_profile: indiekitCollections.get("ap_profile"),
      ap_featured: indiekitCollections.get("ap_featured"),
      ap_featured_tags: indiekitCollections.get("ap_featured_tags"),
      // Reader collections
      ap_timeline: indiekitCollections.get("ap_timeline"),
      ap_notifications: indiekitCollections.get("ap_notifications"),
      ap_muted: indiekitCollections.get("ap_muted"),
      ap_blocked: indiekitCollections.get("ap_blocked"),
      ap_interactions: indiekitCollections.get("ap_interactions"),
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

    // Performance indexes for inbox handlers and batch refollow
    this._collections.ap_followers.createIndex(
      { actorUrl: 1 },
      { unique: true, background: true },
    );
    this._collections.ap_following.createIndex(
      { actorUrl: 1 },
      { unique: true, background: true },
    );
    this._collections.ap_following.createIndex(
      { source: 1 },
      { background: true },
    );
    this._collections.ap_activities.createIndex(
      { objectUrl: 1 },
      { background: true },
    );
    this._collections.ap_activities.createIndex(
      { type: 1, actorUrl: 1, objectUrl: 1 },
      { background: true },
    );

    // Reader indexes (timeline, notifications, moderation, interactions)
    this._collections.ap_timeline.createIndex(
      { uid: 1 },
      { unique: true, background: true },
    );
    this._collections.ap_timeline.createIndex(
      { published: -1 },
      { background: true },
    );
    this._collections.ap_timeline.createIndex(
      { "author.url": 1 },
      { background: true },
    );
    this._collections.ap_timeline.createIndex(
      { type: 1, published: -1 },
      { background: true },
    );

    this._collections.ap_notifications.createIndex(
      { uid: 1 },
      { unique: true, background: true },
    );
    this._collections.ap_notifications.createIndex(
      { published: -1 },
      { background: true },
    );
    this._collections.ap_notifications.createIndex(
      { read: 1 },
      { background: true },
    );

    this._collections.ap_muted.createIndex(
      { url: 1 },
      { unique: true, sparse: true, background: true },
    );
    this._collections.ap_muted.createIndex(
      { keyword: 1 },
      { unique: true, sparse: true, background: true },
    );

    this._collections.ap_blocked.createIndex(
      { url: 1 },
      { unique: true, background: true },
    );

    this._collections.ap_interactions.createIndex(
      { objectUrl: 1, type: 1 },
      { unique: true, background: true },
    );
    this._collections.ap_interactions.createIndex(
      { type: 1 },
      { background: true },
    );

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
      redisUrl: this.options.redisUrl,
      publicationUrl: this._publicationUrl,
      parallelWorkers: this.options.parallelWorkers,
      actorType: this.options.actorType,
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

    // Start batch re-follow processor after federation settles
    const refollowOptions = {
      federation: this._federation,
      collections: this._collections,
      handle: this.options.actor.handle,
      publicationUrl: this._publicationUrl,
    };
    setTimeout(() => {
      startBatchRefollow(refollowOptions).catch((error) => {
        console.error("[ActivityPub] Batch refollow start failed:", error.message);
      });
    }, 10_000);

    // Schedule timeline retention cleanup (runs on startup + every 24h)
    if (this.options.timelineRetention > 0) {
      scheduleCleanup(this._collections, this.options.timelineRetention);
    }
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
