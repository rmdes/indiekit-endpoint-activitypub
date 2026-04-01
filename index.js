import express from "express";
import { waitForReady } from "@rmdes/indiekit-startup-gate";

import { setupFederation, buildPersonActor } from "./lib/federation-setup.js";
import { createMastodonRouter } from "./lib/mastodon/router.js";
import { setLocalIdentity } from "./lib/mastodon/entities/status.js";
import { initRedisCache } from "./lib/redis-cache.js";
import { createIndexes } from "./lib/init-indexes.js";
import { lookupWithSecurity } from "./lib/lookup-helpers.js";
import {
  needsDirectFollow,
  sendDirectFollow,
  sendDirectUnfollow,
} from "./lib/direct-follow.js";
import {
  createFedifyMiddleware,
} from "./lib/federation-bridge.js";
import {
  jf2ToActivityStreams,
  jf2ToAS2Activity,
} from "./lib/jf2-to-as2.js";
import { createSyndicator } from "./lib/syndicator.js";
import { dashboardController } from "./lib/controllers/dashboard.js";
import {
  readerController,
  notificationsController,
  markAllNotificationsReadController,
  clearAllNotificationsController,
  deleteNotificationController,
  composeController,
  submitComposeController,
  remoteProfileController,
  followController,
  unfollowController,
  postDetailController,
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
  blockServerController,
  unblockServerController,
  moderationController,
  filterModeController,
} from "./lib/controllers/moderation.js";
import { followersController } from "./lib/controllers/followers.js";
import {
  approveFollowController,
  rejectFollowController,
} from "./lib/controllers/follow-requests.js";
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
import { resolveController } from "./lib/controllers/resolve.js";
import { tagTimelineController } from "./lib/controllers/tag-timeline.js";
import { apiTimelineController, countNewController, markReadController } from "./lib/controllers/api-timeline.js";
import {
  exploreController,
  exploreApiController,
  instanceSearchApiController,
  instanceCheckApiController,
  popularAccountsApiController,
} from "./lib/controllers/explore.js";
import {
  followTagController,
  unfollowTagController,
  followTagGloballyController,
  unfollowTagGloballyController,
} from "./lib/controllers/follow-tag.js";
import {
  listTabsController,
  addTabController,
  removeTabController,
  reorderTabsController,
} from "./lib/controllers/tabs.js";
import { hashtagExploreApiController } from "./lib/controllers/hashtag-explore.js";
import { publicProfileController } from "./lib/controllers/public-profile.js";
import {
  messagesController,
  messageComposeController,
  submitMessageController,
  markAllMessagesReadController,
  clearAllMessagesController,
  deleteMessageController,
} from "./lib/controllers/messages.js";
import { authorizeInteractionController } from "./lib/controllers/authorize-interaction.js";
import { myProfileController } from "./lib/controllers/my-profile.js";
import {
  refollowPauseController,
  refollowResumeController,
  refollowStatusController,
} from "./lib/controllers/refollow.js";
import { startBatchRefollow } from "./lib/batch-refollow.js";
import { logActivity } from "./lib/activity-log.js";
import { batchBroadcast } from "./lib/batch-broadcast.js";
import { scheduleCleanup } from "./lib/timeline-cleanup.js";
import { runSeparateMentionsMigration } from "./lib/migrations/separate-mentions.js";
import { loadBlockedServersToRedis } from "./lib/storage/server-blocks.js";
import { scheduleKeyRefresh } from "./lib/key-refresh.js";
import { startInboxProcessor } from "./lib/inbox-queue.js";
import { deleteFederationController } from "./lib/controllers/federation-delete.js";
import {
  federationMgmtController,
  rebroadcastController,
  viewApJsonController,
  broadcastActorUpdateController,
  lookupObjectController,
} from "./lib/controllers/federation-mgmt.js";
import {
  settingsGetController,
  settingsPostController,
} from "./lib/controllers/settings.js";

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
  logLevel: "warning",
  timelineRetention: 1000,
  notificationRetentionDays: 30,
  debugDashboard: false,
  debugPassword: "",
  defaultVisibility: "public", // "public" | "unlisted" | "followers"
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
    return [
      {
        href: this.options.mountPath,
        text: "activitypub.title",
        requiresDatabase: true,
      },
      {
        href: `${this.options.mountPath}/admin/reader`,
        text: "activitypub.reader.title",
        requiresDatabase: true,
      },
      {
        href: `${this.options.mountPath}/admin/reader/notifications`,
        text: "activitypub.notifications.title",
        requiresDatabase: true,
      },
      {
        href: `${this.options.mountPath}/admin/reader/messages`,
        text: "activitypub.messages.title",
        requiresDatabase: true,
      },
      {
        href: `${this.options.mountPath}/admin/reader/moderation`,
        text: "activitypub.moderation.title",
        requiresDatabase: true,
      },
      {
        href: `${this.options.mountPath}/admin/my-profile`,
        text: "activitypub.myProfile.title",
        requiresDatabase: true,
      },
      {
        href: `${this.options.mountPath}/admin/federation`,
        text: "activitypub.federationMgmt.title",
        requiresDatabase: true,
      },
      {
        href: `${this.options.mountPath}/admin/settings`,
        text: "activitypub.settings.title",
        requiresDatabase: true,
      },
    ];
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

      // Fedify's acceptsJsonLd() treats Accept: */* as NOT accepting JSON-LD
      // (it only returns true for explicit application/activity+json etc.).
      // Remote servers fetching actor URLs for HTTP Signature verification
      // (e.g. tags.pub) often omit Accept or use */* — they get HTML back
      // instead of the actor JSON, causing "public key not found" errors.
      // Fix: for GET requests to actor paths, upgrade ambiguous Accept headers
      // to application/activity+json so Fedify serves JSON-LD. Explicit
      // text/html requests (browsers) are unaffected.
      if (req.method === "GET" && /^\/users\/[^/]+\/?$/.test(req.path)) {
        const accept = req.get("accept") || "";
        if (!accept.includes("text/html") && !accept.includes("application/xhtml+xml")) {
          req.headers["accept"] = "application/activity+json";
        }
      }

      return self._fedifyMiddleware(req, res, next);
    });

    // Authorize interaction — remote follow / subscribe endpoint.
    // Remote servers redirect users here via the WebFinger subscribe template.
    router.get("/authorize_interaction", authorizeInteractionController(self));

    // HTML fallback for actor URL — serve a public profile page.
    // Fedify only serves JSON-LD; browsers get 406 and fall through here.
    router.get("/users/:identifier", publicProfileController(self));

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
    router.get("/admin/reader/tag", tagTimelineController(mp));
    router.get("/admin/reader/api/timeline", apiTimelineController(mp));
    router.get("/admin/reader/api/timeline/count-new", countNewController());
    router.post("/admin/reader/api/timeline/mark-read", markReadController());
    router.get("/admin/reader/explore", exploreController(mp));
    router.get("/admin/reader/api/explore", exploreApiController(mp));
    router.get("/admin/reader/api/explore/hashtag", hashtagExploreApiController(mp));
    router.get("/admin/reader/api/instances", instanceSearchApiController(mp));
    router.get("/admin/reader/api/instance-check", instanceCheckApiController(mp));
    router.get("/admin/reader/api/popular-accounts", popularAccountsApiController(mp));
    router.get("/admin/reader/api/tabs", listTabsController(mp));
    router.post("/admin/reader/api/tabs", addTabController(mp));
    router.post("/admin/reader/api/tabs/remove", removeTabController(mp));
    router.patch("/admin/reader/api/tabs/reorder", reorderTabsController(mp));
    router.post("/admin/reader/follow-tag", followTagController(mp));
    router.post("/admin/reader/unfollow-tag", unfollowTagController(mp));
    router.post("/admin/reader/follow-tag-global", followTagGloballyController(mp, this));
    router.post("/admin/reader/unfollow-tag-global", unfollowTagGloballyController(mp, this));
    router.get("/admin/reader/notifications", notificationsController(mp));
    router.post("/admin/reader/notifications/mark-read", markAllNotificationsReadController(mp));
    router.post("/admin/reader/notifications/clear", clearAllNotificationsController(mp));
    router.post("/admin/reader/notifications/delete", deleteNotificationController(mp));
    router.get("/admin/reader/messages", messagesController(mp));
    router.get("/admin/reader/messages/compose", messageComposeController(mp, this));
    router.post("/admin/reader/messages/compose", submitMessageController(mp, this));
    router.post("/admin/reader/messages/mark-read", markAllMessagesReadController(mp));
    router.post("/admin/reader/messages/clear", clearAllMessagesController(mp));
    router.post("/admin/reader/messages/delete", deleteMessageController(mp));
    router.get("/admin/reader/compose", composeController(mp, this));
    router.post("/admin/reader/compose", submitComposeController(mp, this));
    router.post("/admin/reader/like", likeController(mp, this));
    router.post("/admin/reader/unlike", unlikeController(mp, this));
    router.post("/admin/reader/boost", boostController(mp, this));
    router.post("/admin/reader/unboost", unboostController(mp, this));
    router.get("/admin/reader/resolve", resolveController(mp, this));
    router.get("/admin/reader/profile", remoteProfileController(mp, this));
    router.get("/admin/reader/post", postDetailController(mp, this));
    router.post("/admin/reader/follow", followController(mp, this));
    router.post("/admin/reader/unfollow", unfollowController(mp, this));
    router.get("/admin/reader/moderation", moderationController(mp));
    router.post("/admin/reader/moderation/filter-mode", filterModeController(mp));
    router.post("/admin/reader/mute", muteController(mp, this));
    router.post("/admin/reader/unmute", unmuteController(mp, this));
    router.post("/admin/reader/block", blockController(mp, this));
    router.post("/admin/reader/unblock", unblockController(mp, this));
    router.post("/admin/reader/block-server", blockServerController(mp));
    router.post("/admin/reader/unblock-server", unblockServerController(mp));
    router.get("/admin/followers", followersController(mp));
    router.post("/admin/followers/approve", approveFollowController(mp, this));
    router.post("/admin/followers/reject", rejectFollowController(mp, this));
    router.get("/admin/following", followingController(mp));
    router.get("/admin/activities", activitiesController(mp));
    router.get("/admin/featured", featuredGetController(mp));
    router.post("/admin/featured/pin", featuredPinController(mp, this));
    router.post("/admin/featured/unpin", featuredUnpinController(mp, this));
    router.get("/admin/tags", featuredTagsGetController(mp));
    router.post("/admin/tags/add", featuredTagsAddController(mp, this));
    router.post("/admin/tags/remove", featuredTagsRemoveController(mp, this));
    router.get("/admin/profile", profileGetController(mp));
    router.post("/admin/profile", profilePostController(mp, this));
    router.get("/admin/my-profile", myProfileController(this));
    router.get("/admin/migrate", migrateGetController(mp, this.options));
    router.post("/admin/migrate", migratePostController(mp, this.options));
    router.post(
      "/admin/migrate/import",
      migrateImportController(mp, this.options),
    );
    router.post("/admin/refollow/pause", refollowPauseController(mp, this));
    router.post("/admin/refollow/resume", refollowResumeController(mp, this));
    router.get("/admin/refollow/status", refollowStatusController(mp));
    router.post("/admin/federation/delete", deleteFederationController(mp, this));
    router.get("/admin/federation", federationMgmtController(mp, this));
    router.post("/admin/federation/rebroadcast", rebroadcastController(mp, this));
    router.get("/admin/federation/ap-json", viewApJsonController(mp, this));
    router.post("/admin/federation/broadcast-actor", broadcastActorUpdateController(mp, this));
    router.get("/admin/federation/lookup", lookupObjectController(mp, this));

    // Settings
    router.get("/admin/settings", settingsGetController(mp));
    router.post("/admin/settings", settingsPostController(mp));

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

        if (!post || post.properties?.deleted) {
          // FEP-4f05: Serve Tombstone for deleted posts
          const { getTombstone } = await import("./lib/storage/tombstones.js");
          const tombstone = await getTombstone(self._collections, requestUrl);
          if (tombstone) {
            res.status(410).set("Content-Type", "application/activity+json").json({
              "@context": "https://www.w3.org/ns/activitystreams",
              type: "Tombstone",
              id: requestUrl,
              formerType: tombstone.formerType,
              published: tombstone.published || undefined,
              deleted: tombstone.deleted,
            });
            return;
          }
          return next();
        }

        const actorUrl = self._getActorUrl();
        const activity = jf2ToActivityStreams(
          post.properties,
          actorUrl,
          self._publicationUrl,
          { visibility: self.options.defaultVisibility },
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
    return createSyndicator(this);
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
  /**
   * Load the RSA private key from ap_keys for direct HTTP Signature signing.
   * @returns {Promise<CryptoKey|null>}
   */
  async _loadRsaPrivateKey() {
    try {
      const keyDoc = await this._collections.ap_keys.findOne({
        privateKeyPem: { $exists: true },
      });
      if (!keyDoc?.privateKeyPem) return null;
      const pemBody = keyDoc.privateKeyPem
        .replace(/-----[^-]+-----/g, "")
        .replace(/\s/g, "");
      return await crypto.subtle.importKey(
        "pkcs8",
        Buffer.from(pemBody, "base64"),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"],
      );
    } catch (error) {
      console.error("[ActivityPub] Failed to load RSA key:", error.message);
      return null;
    }
  }

  async followActor(actorUrl, actorInfo = {}) {
    if (!this._federation) {
      return { ok: false, error: "Federation not initialized" };
    }

    try {
      const { Follow } = await import("@fedify/fedify/vocab");
      const handle = this.options.actor.handle;
      const ctx = this._federation.createContext(
        new URL(this._publicationUrl),
        { handle, publicationUrl: this._publicationUrl },
      );

      // Resolve the remote actor to get their inbox
      // lookupWithSecurity handles signed→unsigned fallback automatically
      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });
      const remoteActor = await lookupWithSecurity(ctx, actorUrl, {
        documentLoader,
      });
      if (!remoteActor) {
        return { ok: false, error: "Could not resolve remote actor" };
      }

      // Send Follow activity
      if (needsDirectFollow(actorUrl)) {
        // tags.pub rejects Fedify's LD Signature context (identity/v1).
        // Send a minimal signed Follow directly, bypassing the outbox pipeline.
        // See: https://github.com/social-web-foundation/tags.pub/issues/10
        const rsaKey = await this._loadRsaPrivateKey();
        if (!rsaKey) {
          return { ok: false, error: "No RSA key available for direct follow" };
        }
        const result = await sendDirectFollow({
          actorUri: ctx.getActorUri(handle).href,
          targetActorUrl: actorUrl,
          inboxUrl: remoteActor.inboxId?.href,
          keyId: `${ctx.getActorUri(handle).href}#main-key`,
          privateKey: rsaKey,
        });
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
      } else {
        const follow = new Follow({
          actor: ctx.getActorUri(handle),
          object: new URL(actorUrl),
        });
        await ctx.sendActivity({ identifier: handle }, remoteActor, follow, {
          orderingKey: actorUrl,
        });
      }

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
      const inbox = remoteActor.inboxId?.href || "";
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
      const { Follow, Undo } = await import("@fedify/fedify/vocab");
      const handle = this.options.actor.handle;
      const ctx = this._federation.createContext(
        new URL(this._publicationUrl),
        { handle, publicationUrl: this._publicationUrl },
      );

      // Use authenticated document loader for servers requiring Authorized Fetch
      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });
      const remoteActor = await lookupWithSecurity(ctx,actorUrl, {
        documentLoader,
      });
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

      if (needsDirectFollow(actorUrl)) {
        // tags.pub rejects Fedify's LD Signature context (identity/v1).
        // See: https://github.com/social-web-foundation/tags.pub/issues/10
        const rsaKey = await this._loadRsaPrivateKey();
        if (rsaKey) {
          const result = await sendDirectUnfollow({
            actorUri: ctx.getActorUri(handle).href,
            targetActorUrl: actorUrl,
            inboxUrl: remoteActor.inboxId?.href,
            keyId: `${ctx.getActorUri(handle).href}#main-key`,
            privateKey: rsaKey,
          });
          if (!result.ok) {
            console.warn(`[ActivityPub] Direct unfollow failed for ${actorUrl}: ${result.error}`);
          }
        }
      } else {
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
      }
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
   * Send an Update(Person) activity to all followers so remote servers
   * re-fetch the actor object (picking up profile changes, new featured
   * collections, attachments, etc.).
   *
   * Delivery is batched to avoid a thundering herd: hundreds of remote
   * servers simultaneously re-fetching the actor, featured posts, and
   * featured tags after receiving the Update all at once.
   */
  async broadcastActorUpdate() {
    if (!this._federation) return;

    try {
      const { Update } = await import("@fedify/fedify/vocab");
      const handle = this.options.actor.handle;
      const ctx = this._federation.createContext(
        new URL(this._publicationUrl),
        { handle, publicationUrl: this._publicationUrl },
      );

      const actor = await buildPersonActor(
        ctx,
        handle,
        this._collections,
        this.options.actorType,
      );
      if (!actor) {
        console.warn("[ActivityPub] broadcastActorUpdate: could not build actor");
        return;
      }

      const update = new Update({
        actor: ctx.getActorUri(handle),
        object: actor,
      });

      await batchBroadcast({
        federation: this._federation,
        collections: this._collections,
        publicationUrl: this._publicationUrl,
        handle,
        activity: update,
        label: "Update(Person)",
        objectUrl: this._getActorUrl(),
      });
    } catch (error) {
      console.error("[ActivityPub] broadcastActorUpdate failed:", error.message);
    }
  }

  /**
   * Send Delete activity to all followers for a removed post.
   * Mirrors broadcastActorUpdate() pattern: batch delivery with shared inbox dedup.
   * @param {string} postUrl - Full URL of the deleted post
   */
  async broadcastDelete(postUrl) {
    if (!this._federation) return;

    try {
      const { Delete } = await import("@fedify/fedify/vocab");
      const handle = this.options.actor.handle;
      const ctx = this._federation.createContext(
        new URL(this._publicationUrl),
        { handle, publicationUrl: this._publicationUrl },
      );

      const del = new Delete({
        actor: ctx.getActorUri(handle),
        object: new URL(postUrl),
      });

      await batchBroadcast({
        federation: this._federation,
        collections: this._collections,
        publicationUrl: this._publicationUrl,
        handle,
        activity: del,
        label: "Delete",
        objectUrl: postUrl,
      });
    } catch (error) {
      console.warn("[ActivityPub] broadcastDelete failed:", error.message);
    }
  }

  /**
   * Called by post-content.js when a Micropub delete succeeds.
   * Broadcasts an ActivityPub Delete activity to all followers.
   * @param {string} url - Full URL of the deleted post
   */
  async delete(url) {
    // Record tombstone for FEP-4f05
    try {
      const { addTombstone } = await import("./lib/storage/tombstones.js");
      const postsCol = this._collections.posts;
      const post = postsCol ? await postsCol.findOne({ "properties.url": url }) : null;
      await addTombstone(this._collections, {
        url,
        formerType: post?.properties?.["post-type"] === "article" ? "Article" : "Note",
        published: post?.properties?.published || null,
        deleted: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(`[ActivityPub] Tombstone creation failed for ${url}: ${error.message}`);
    }

    await this.broadcastDelete(url).catch((err) =>
      console.warn(`[ActivityPub] broadcastDelete failed for ${url}: ${err.message}`)
    );
  }

  /**
   * Called by post-content.js when a Micropub update succeeds.
   * Broadcasts an ActivityPub Update activity for the post to all followers.
   * @param {object} properties - JF2 post properties (must include url)
   */
  async update(properties) {
    await this.broadcastPostUpdate(properties).catch((err) =>
      console.warn(`[ActivityPub] broadcastPostUpdate failed for ${properties?.url}: ${err.message}`)
    );
  }

  /**
   * Send an Update activity to all followers for a modified post.
   * Mirrors broadcastDelete() pattern: batch delivery with shared inbox dedup.
   * @param {object} properties - JF2 post properties
   */
  async broadcastPostUpdate(properties) {
    if (!this._federation) return;

    try {
      const { Update } = await import("@fedify/fedify/vocab");
      const actorUrl = this._getActorUrl();
      const handle = this.options.actor.handle;
      const ctx = this._federation.createContext(
        new URL(this._publicationUrl),
        { handle, publicationUrl: this._publicationUrl },
      );

      const createActivity = jf2ToAS2Activity(
        properties,
        actorUrl,
        this._publicationUrl,
        { visibility: this.options.defaultVisibility },
      );

      if (!createActivity) {
        console.warn(`[ActivityPub] broadcastPostUpdate: could not convert post to AS2 for ${properties?.url}`);
        return;
      }

      const noteObject = await createActivity.getObject();
      const activity = new Update({
        actor: ctx.getActorUri(handle),
        object: noteObject,
      });

      await batchBroadcast({
        federation: this._federation,
        collections: this._collections,
        publicationUrl: this._publicationUrl,
        handle,
        activity,
        label: "Update(Note)",
        objectUrl: properties.url,
      });
    } catch (error) {
      console.warn("[ActivityPub] broadcastPostUpdate failed:", error.message);
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
    Indiekit.addCollection("ap_followed_tags");
    // Message collections
    Indiekit.addCollection("ap_messages");
    // Explore tab collections
    Indiekit.addCollection("ap_explore_tabs");
    // Reports collection
    Indiekit.addCollection("ap_reports");
    // Pending follow requests (manual approval)
    Indiekit.addCollection("ap_pending_follows");
    // Server-level blocks
    Indiekit.addCollection("ap_blocked_servers");
    // Key freshness tracking for proactive refresh
    Indiekit.addCollection("ap_key_freshness");
    // Async inbox processing queue
    Indiekit.addCollection("ap_inbox_queue");
    // Mastodon Client API collections
    Indiekit.addCollection("ap_oauth_apps");
    Indiekit.addCollection("ap_oauth_tokens");
    Indiekit.addCollection("ap_markers");
    // Tombstones for soft-deleted posts (FEP-4f05)
    Indiekit.addCollection("ap_tombstones");
    // Media attachments (Mastodon API upload)
    Indiekit.addCollection("ap_media");
    // Status edit history
    Indiekit.addCollection("ap_status_edits");
    // Idempotency keys for Mastodon API
    Indiekit.addCollection("ap_idempotency");
    // Filters and filter keywords
    Indiekit.addCollection("ap_filters");
    Indiekit.addCollection("ap_filter_keywords");

    // Plugin settings (single document, admin UI at /admin/settings)
    Indiekit.addCollection("ap_settings");

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
      ap_followed_tags: indiekitCollections.get("ap_followed_tags"),
      // Message collections
      ap_messages: indiekitCollections.get("ap_messages"),
      // Explore tab collections
      ap_explore_tabs: indiekitCollections.get("ap_explore_tabs"),
      // Reports collection
      ap_reports: indiekitCollections.get("ap_reports"),
      // Pending follow requests (manual approval)
      ap_pending_follows: indiekitCollections.get("ap_pending_follows"),
      // Server-level blocks
      ap_blocked_servers: indiekitCollections.get("ap_blocked_servers"),
      // Key freshness tracking
      ap_key_freshness: indiekitCollections.get("ap_key_freshness"),
      // Async inbox processing queue
      ap_inbox_queue: indiekitCollections.get("ap_inbox_queue"),
      // Mastodon Client API collections
      ap_oauth_apps: indiekitCollections.get("ap_oauth_apps"),
      ap_oauth_tokens: indiekitCollections.get("ap_oauth_tokens"),
      ap_markers: indiekitCollections.get("ap_markers"),
      ap_tombstones: indiekitCollections.get("ap_tombstones"),
      // Media attachments (Mastodon API upload)
      ap_media: indiekitCollections.get("ap_media"),
      // Status edit history
      ap_status_edits: indiekitCollections.get("ap_status_edits"),
      // Idempotency keys for Mastodon API
      ap_idempotency: indiekitCollections.get("ap_idempotency"),
      // Filters and filter keywords
      ap_filters: indiekitCollections.get("ap_filters"),
      ap_filter_keywords: indiekitCollections.get("ap_filter_keywords"),
      get posts() {
        return indiekitCollections.get("posts");
      },
      _publicationUrl: this._publicationUrl,
    };

    // Create indexes (idempotent — safe on every startup)
    createIndexes(this._collections, {
      activityRetentionDays: this.options.activityRetentionDays,
      notificationRetentionDays: this.options.notificationRetentionDays,
    });

    // Seed actor profile from config on first run
    this._seedProfile().catch((error) => {
      console.warn("[ActivityPub] Profile seed failed:", error.message);
    });

    // Initialize Redis cache for plugin-level KV (fedidb, batch-refollow, etc.)
    if (this.options.redisUrl) {
      initRedisCache(this.options.redisUrl);
    }

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
      logLevel: this.options.logLevel,
      debugDashboard: this.options.debugDashboard,
      debugPassword: this.options.debugPassword,
    });

    this._federation = federation;
    this._fedifyMiddleware = createFedifyMiddleware(federation, () => ({}));

    // Expose signed avatar resolver for cross-plugin use (e.g., conversations backfill)
    Indiekit.config.application.resolveActorAvatar = async (actorUrl) => {
      try {
        const handle = this.options.actor.handle;
        const ctx = this._federation.createContext(
          new URL(this._publicationUrl),
          { handle, publicationUrl: this._publicationUrl },
        );
        const documentLoader = await ctx.getDocumentLoader({
          identifier: handle,
        });
        const actor = await lookupWithSecurity(ctx,new URL(actorUrl), {
          documentLoader,
        });
        if (!actor) return "";
        const { extractActorInfo } = await import("./lib/timeline-store.js");
        const info = await extractActorInfo(actor, { documentLoader });
        return info.photo || "";
      } catch {
        return "";
      }
    };

    // Register as endpoint (mounts routesPublic, routesWellKnown, routes)
    Indiekit.addEndpoint(this);

    // Content negotiation + NodeInfo — virtual endpoint at root
    Indiekit.addEndpoint({
      name: "ActivityPub content negotiation",
      mountPath: "/",
      routesPublic: this.contentNegotiationRoutes,
    });

    // Set local identity for own-post detection in status serialization
    setLocalIdentity(this._publicationUrl, this.options.actor?.handle || "user");

    // Mastodon Client API — virtual endpoint at root
    // Mastodon-compatible clients (Phanpy, Elk, etc.) expect /api/v1/*,
    // /api/v2/*, /oauth/* at the domain root, not under /activitypub.
    const pluginRef = this;
    const mastodonRouter = createMastodonRouter({
      collections: this._collections,
      pluginOptions: {
        handle: this.options.actor?.handle || "user",
        publicationUrl: this._publicationUrl,
        federation: this._federation,
        followActor: (url, info) => pluginRef.followActor(url, info),
        unfollowActor: (url) => pluginRef.unfollowActor(url),
        broadcastActorUpdate: () => pluginRef.broadcastActorUpdate(),
        loadRsaKey: () => pluginRef._loadRsaPrivateKey(),
      },
    });
    Indiekit.addEndpoint({
      name: "Mastodon Client API",
      mountPath: "/",
      routesPublic: mastodonRouter,
    });

    // Register syndicator (appears in post editing UI)
    Indiekit.addSyndicator(this.syndicator);

    // Run one-time migrations (idempotent — safe to run on every startup)
    console.info("[ActivityPub] Init: starting post-refollow setup");
    runSeparateMentionsMigration(this._collections).then(({ skipped, updated }) => {
      if (!skipped) {
        console.log(`[ActivityPub] Migration separate-mentions: updated ${updated} timeline items`);
      }
    }).catch((error) => {
      console.error("[ActivityPub] Migration separate-mentions failed:", error.message);
    });

    // Defer background workers until host is ready
    const refollowOptions = {
      federation: this._federation,
      collections: this._collections,
      handle: this.options.actor.handle,
      publicationUrl: this._publicationUrl,
    };
    const keyRefreshHandle = this.options.actor.handle;
    const keyRefreshFederation = this._federation;
    const keyRefreshPubUrl = this._publicationUrl;
    this._stopGate = waitForReady(
      () => {
        // Start batch re-follow processor
        startBatchRefollow(refollowOptions).catch((error) => {
          console.error("[ActivityPub] Batch refollow start failed:", error.message);
        });

        // Schedule timeline retention cleanup (runs on startup + every 24h)
        if (this.options.timelineRetention > 0) {
          scheduleCleanup(this._collections, this.options.timelineRetention);
        }

        // Load server blocks into Redis for fast inbox checks
        loadBlockedServersToRedis(this._collections).catch((error) => {
          console.warn("[ActivityPub] Failed to load blocked servers to Redis:", error.message);
        });

        // Schedule proactive key refresh for stale follower keys (runs on startup + every 24h)
        scheduleKeyRefresh(
          this._collections,
          () => keyRefreshFederation?.createContext(new URL(keyRefreshPubUrl), {
            handle: keyRefreshHandle,
            publicationUrl: keyRefreshPubUrl,
          }),
          keyRefreshHandle,
        );

        // Backfill ap_timeline from posts collection (idempotent, runs on every startup)
        import("./lib/mastodon/backfill-timeline.js").then(({ backfillTimeline }) => {
          backfillTimeline(this._collections).then(({ total, inserted, skipped }) => {
            if (inserted > 0) {
              console.log(`[Mastodon API] Timeline backfill: ${inserted} posts added (${skipped} already existed, ${total} total)`);
            }
          }).catch((error) => {
            console.warn("[Mastodon API] Timeline backfill failed:", error.message);
          });
        });

        // Start async inbox queue processor (processes one item every 3s)
        console.info("[ActivityPub] Init: starting inbox queue processor");
        this._inboxProcessorInterval = startInboxProcessor(
          this._collections,
          () => this._federation?.createContext(new URL(this._publicationUrl), {
            handle: this.options.actor.handle,
            publicationUrl: this._publicationUrl,
          }),
          this.options.actor.handle,
        );
      },
      { label: "ActivityPub" },
    );
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

  destroy() {
    this._stopGate?.();
    if (this._inboxProcessorInterval) {
      clearInterval(this._inboxProcessorInterval);
    }
  }
}
