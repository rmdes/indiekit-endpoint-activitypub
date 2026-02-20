/**
 * Fedify Federation setup — configures the Federation instance with all
 * dispatchers, inbox listeners, and collection handlers.
 *
 * This replaces the hand-rolled federation.js, actor.js, keys.js, webfinger.js,
 * and inbox.js with Fedify's battle-tested implementations.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { Temporal } from "@js-temporal/polyfill";
import {
  Application,
  Article,
  Create,
  Endpoints,
  Group,
  Hashtag,
  Image,
  InProcessMessageQueue,
  Note,
  Organization,
  ParallelMessageQueue,
  Person,
  PropertyValue,
  Service,
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
  importSpki,
} from "@fedify/fedify";
import { configure, getConsoleSink } from "@logtape/logtape";
import { RedisMessageQueue } from "@fedify/redis";
import Redis from "ioredis";
import { MongoKvStore } from "./kv-store.js";
import { registerInboxListeners } from "./inbox-listeners.js";
import { jf2ToAS2Activity, resolvePostUrl } from "./jf2-to-as2.js";

/**
 * Create and configure a Fedify Federation instance.
 *
 * @param {object} options
 * @param {object} options.collections - MongoDB collections
 * @param {string} options.mountPath - Plugin mount path (e.g. "/activitypub")
 * @param {string} options.handle - Actor handle (e.g. "rick")
 * @param {boolean} options.storeRawActivities - Whether to store full raw JSON
 * @returns {{ federation: import("@fedify/fedify").Federation }}
 */
// Track whether LogTape has been configured (can only call configure() once)
let _logtapeConfigured = false;

export function setupFederation(options) {
  const {
    collections,
    mountPath,
    handle,
    storeRawActivities = false,
    redisUrl = "",
    publicationUrl = "",
    parallelWorkers = 5,
    actorType = "Person",
  } = options;

  // Map config string to Fedify actor class
  const actorTypeMap = { Person, Service, Application, Organization, Group };
  const ActorClass = actorTypeMap[actorType] || Person;

  // Configure LogTape for Fedify delivery logging (once per process)
  if (!_logtapeConfigured) {
    _logtapeConfigured = true;
    configure({
      contextLocalStorage: new AsyncLocalStorage(),
      sinks: {
        console: getConsoleSink(),
      },
      loggers: [
        {
          // All Fedify logs — federation, vocab, delivery, HTTP signatures
          category: ["fedify"],
          sinks: ["console"],
          lowestLevel: "info",
        },
      ],
    }).catch((error) => {
      console.warn("[ActivityPub] LogTape configure failed:", error.message);
    });
  }

  let queue;
  if (redisUrl) {
    const redisQueue = new RedisMessageQueue(() => new Redis(redisUrl));
    if (parallelWorkers > 1) {
      queue = new ParallelMessageQueue(redisQueue, parallelWorkers);
      console.info(
        `[ActivityPub] Using Redis message queue with ${parallelWorkers} parallel workers`,
      );
    } else {
      queue = redisQueue;
      console.info("[ActivityPub] Using Redis message queue (single worker)");
    }
  } else {
    queue = new InProcessMessageQueue();
    console.warn(
      "[ActivityPub] Using in-process message queue (not recommended for production)",
    );
  }

  const federation = createFederation({
    kv: new MongoKvStore(collections.ap_kv),
    queue,
  });

  // --- Actor dispatcher ---
  federation
    .setActorDispatcher(
      `${mountPath}/users/{identifier}`,
      async (ctx, identifier) => {
        // Instance actor: Application-type actor for the domain itself
        // Required for authorized fetch to avoid infinite loops
        const hostname = ctx.url?.hostname || "";
        if (identifier === hostname) {
          const keyPairs = await ctx.getActorKeyPairs(identifier);
          const appOptions = {
            id: ctx.getActorUri(identifier),
            preferredUsername: hostname,
            name: hostname,
            inbox: ctx.getInboxUri(identifier),
            outbox: ctx.getOutboxUri(identifier),
            endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
          };
          if (keyPairs.length > 0) {
            appOptions.publicKey = keyPairs[0].cryptographicKey;
            appOptions.assertionMethods = keyPairs.map((k) => k.multikey);
          }
          return new Application(appOptions);
        }

        if (identifier !== handle) return null;

        const profile = await getProfile(collections);
        const keyPairs = await ctx.getActorKeyPairs(identifier);

        const personOptions = {
          id: ctx.getActorUri(identifier),
          preferredUsername: identifier,
          name: profile.name || identifier,
          url: profile.url ? new URL(profile.url) : null,
          inbox: ctx.getInboxUri(identifier),
          outbox: ctx.getOutboxUri(identifier),
          followers: ctx.getFollowersUri(identifier),
          following: ctx.getFollowingUri(identifier),
          liked: ctx.getLikedUri(identifier),
          featured: ctx.getFeaturedUri(identifier),
          featuredTags: ctx.getFeaturedTagsUri(identifier),
          endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
          manuallyApprovesFollowers:
            profile.manuallyApprovesFollowers || false,
        };

        if (profile.summary) {
          personOptions.summary = profile.summary;
        }

        if (profile.icon) {
          personOptions.icon = new Image({
            url: new URL(profile.icon),
            mediaType: guessImageMediaType(profile.icon),
          });
        }

        if (profile.image) {
          personOptions.image = new Image({
            url: new URL(profile.image),
            mediaType: guessImageMediaType(profile.image),
          });
        }

        if (keyPairs.length > 0) {
          personOptions.publicKey = keyPairs[0].cryptographicKey;
          personOptions.assertionMethods = keyPairs.map((k) => k.multikey);
        }

        if (profile.attachments?.length > 0) {
          personOptions.attachments = profile.attachments.map(
            (att) => new PropertyValue({ name: att.name, value: att.value }),
          );
        }

        if (profile.alsoKnownAs?.length > 0) {
          personOptions.alsoKnownAs = profile.alsoKnownAs.map(
            (u) => new URL(u),
          );
        }

        if (profile.createdAt) {
          personOptions.published = Temporal.Instant.from(profile.createdAt);
        }

        return new ActorClass(personOptions);
      },
    )
    .mapHandle((_ctx, username) => {
      if (username === handle) return handle;
      // Accept hostname as valid identifier for instance actor
      if (publicationUrl) {
        try {
          const hostname = new URL(publicationUrl).hostname;
          if (username === hostname) return hostname;
        } catch { /* ignore */ }
      }
      return null;
    })
    .mapAlias((_ctx, alias) => {
      // Resolve profile URL and /@handle patterns via WebFinger.
      // Must return { identifier } or { username }, not a bare string.
      if (!publicationUrl) return null;
      try {
        const pub = new URL(publicationUrl);
        if (alias.hostname !== pub.hostname) return null;
        const path = alias.pathname.replace(/\/$/, "");
        if (path === "" || path === `/@${handle}`) return { identifier: handle };
      } catch { /* ignore */ }
      return null;
    })
    .setKeyPairsDispatcher(async (ctx, identifier) => {
      // Allow key pairs for both the main actor and instance actor
      const hostname = ctx.url?.hostname || "";
      if (identifier !== handle && identifier !== hostname) return [];

      const keyPairs = [];

      // --- Legacy RSA key pair (HTTP Signatures) ---
      const legacyKey = await collections.ap_keys.findOne({ type: "rsa" });
      // Fall back to old schema (no type field) for backward compat
      const rsaDoc =
        legacyKey ||
        (await collections.ap_keys.findOne({
          publicKeyPem: { $exists: true },
        }));

      if (rsaDoc?.publicKeyPem && rsaDoc?.privateKeyPem) {
        try {
          const publicKey = await importSpki(rsaDoc.publicKeyPem);
          const privateKey = await importPkcs8Pem(rsaDoc.privateKeyPem);
          keyPairs.push({ publicKey, privateKey });
        } catch {
          console.warn("[ActivityPub] Could not import legacy RSA keys");
        }
      }

      // --- Ed25519 key pair (Object Integrity Proofs) ---
      // Load from DB or generate + persist on first use
      let ed25519Doc = await collections.ap_keys.findOne({
        type: "ed25519",
      });

      if (ed25519Doc?.publicKeyJwk && ed25519Doc?.privateKeyJwk) {
        try {
          const publicKey = await importJwk(
            ed25519Doc.publicKeyJwk,
            "public",
          );
          const privateKey = await importJwk(
            ed25519Doc.privateKeyJwk,
            "private",
          );
          keyPairs.push({ publicKey, privateKey });
        } catch (error) {
          console.warn(
            "[ActivityPub] Could not import Ed25519 keys, regenerating:",
            error.message,
          );
          ed25519Doc = null; // Force regeneration below
        }
      }

      if (!ed25519Doc) {
        try {
          const ed25519 = await generateCryptoKeyPair("Ed25519");
          await collections.ap_keys.insertOne({
            type: "ed25519",
            publicKeyJwk: await exportJwk(ed25519.publicKey),
            privateKeyJwk: await exportJwk(ed25519.privateKey),
            createdAt: new Date().toISOString(),
          });
          keyPairs.push(ed25519);
          console.info(
            "[ActivityPub] Generated and persisted Ed25519 key pair",
          );
        } catch (error) {
          console.warn(
            "[ActivityPub] Could not generate Ed25519 key pair:",
            error.message,
          );
        }
      }

      return keyPairs;
    });
    // NOTE: .authorize() is intentionally NOT chained here.
    // Fedify's authorize predicate triggers HTTP Signature verification on
    // every GET to the actor endpoint. When a remote server that requires
    // authorized fetch (e.g. kobolds.online, void.ello.tech) requests our
    // actor, Fedify tries to fetch THEIR public key to verify the signature.
    // Those instances return 401, causing a FetchError that Fedify doesn't
    // catch — resulting in 500s for those servers and error log spam.
    // Authorized fetch requires authenticated document loading (using the
    // instance actor's keys for outgoing fetches), which Fedify doesn't yet
    // support out of the box. Re-enable once Fedify adds this capability.

  // --- Inbox listeners ---
  const inboxChain = federation.setInboxListeners(
    `${mountPath}/users/{identifier}/inbox`,
    `${mountPath}/inbox`,
  );
  registerInboxListeners(inboxChain, {
    collections,
    handle,
    storeRawActivities,
  });

  // Enable authenticated fetches for the shared inbox.
  // Without this, Fedify can't verify incoming HTTP Signatures from servers
  // that require authorized fetch (e.g. hachyderm.io returns 401 on unsigned GETs).
  // This tells Fedify to use our actor's key pair when fetching remote actor
  // documents during signature verification on the shared inbox.
  inboxChain.setSharedKeyDispatcher((_ctx) => ({ identifier: handle }));

  // --- Collection dispatchers ---
  setupFollowers(federation, mountPath, handle, collections);
  setupFollowing(federation, mountPath, handle, collections);
  setupOutbox(federation, mountPath, handle, collections);
  setupLiked(federation, mountPath, handle, collections);
  setupFeatured(federation, mountPath, handle, collections, publicationUrl);
  setupFeaturedTags(federation, mountPath, handle, collections, publicationUrl);

  // --- Object dispatchers (make posts dereferenceable) ---
  setupObjectDispatchers(federation, mountPath, handle, collections, publicationUrl);

  // --- NodeInfo ---
  let softwareVersion = { major: 1, minor: 0, patch: 0 };
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@indiekit/indiekit/package.json");
    const [major, minor, patch] = pkg.version.split(/[.-]/).map(Number);
    if (!Number.isNaN(major)) softwareVersion = { major, minor: minor || 0, patch: patch || 0 };
  } catch { /* fallback to 1.0.0 */ }

  federation.setNodeInfoDispatcher("/nodeinfo/2.1", async () => {
    const postsCount = collections.posts
      ? await collections.posts.countDocuments()
      : 0;

    return {
      software: {
        name: "indiekit",
        version: softwareVersion,
      },
      protocols: ["activitypub"],
      usage: {
        users: { total: 1, activeMonth: 1, activeHalfyear: 1 },
        localPosts: postsCount,
        localComments: 0,
      },
    };
  });

  // Start the message queue for outbound activity delivery.
  // Without this, ctx.sendActivity() enqueues delivery tasks but the
  // InProcessMessageQueue never processes them — activities are never
  // actually POSTed to follower inboxes.
  federation.startQueue().catch((error) => {
    console.error("[ActivityPub] Failed to start delivery queue:", error.message);
  });

  return { federation };
}

// --- Collection setup helpers ---

function setupFollowers(federation, mountPath, handle, collections) {
  federation
    .setFollowersDispatcher(
      `${mountPath}/users/{identifier}/followers`,
      async (ctx, identifier, cursor) => {
        if (identifier !== handle) return null;

        // One-shot collection: when cursor is null, return ALL followers
        // as Recipient objects so sendActivity("followers") can deliver.
        // See: https://fedify.dev/manual/collections#one-shot-followers-collection-for-gathering-recipients
        if (cursor == null) {
          const docs = await collections.ap_followers
            .find()
            .sort({ followedAt: -1 })
            .toArray();
          return {
            items: docs.map((f) => ({
              id: new URL(f.actorUrl),
              inboxId: f.inbox ? new URL(f.inbox) : null,
              endpoints: f.sharedInbox
                ? { sharedInbox: new URL(f.sharedInbox) }
                : null,
            })),
          };
        }

        // Paginated collection: for remote browsing of /followers endpoint
        const pageSize = 20;
        const skip = Number.parseInt(cursor, 10);
        const docs = await collections.ap_followers
          .find()
          .sort({ followedAt: -1 })
          .skip(skip)
          .limit(pageSize)
          .toArray();
        const total = await collections.ap_followers.countDocuments();

        return {
          items: docs.map((f) => new URL(f.actorUrl)),
          nextCursor:
            skip + pageSize < total ? String(skip + pageSize) : null,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      if (identifier !== handle) return 0;
      return await collections.ap_followers.countDocuments();
    })
    .setFirstCursor(async () => "0");
}

function setupFollowing(federation, mountPath, handle, collections) {
  federation
    .setFollowingDispatcher(
      `${mountPath}/users/{identifier}/following`,
      async (ctx, identifier, cursor) => {
        if (identifier !== handle) return null;
        const pageSize = 20;
        const skip = cursor ? Number.parseInt(cursor, 10) : 0;
        const docs = await collections.ap_following
          .find()
          .sort({ followedAt: -1 })
          .skip(skip)
          .limit(pageSize)
          .toArray();
        const total = await collections.ap_following.countDocuments();

        return {
          items: docs.map((f) => new URL(f.actorUrl)),
          nextCursor:
            skip + pageSize < total ? String(skip + pageSize) : null,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      if (identifier !== handle) return 0;
      return await collections.ap_following.countDocuments();
    })
    .setFirstCursor(async () => "0");
}

function setupLiked(federation, mountPath, handle, collections) {
  federation
    .setLikedDispatcher(
      `${mountPath}/users/{identifier}/liked`,
      async (ctx, identifier, cursor) => {
        if (identifier !== handle) return null;
        if (!collections.posts) return { items: [] };

        const pageSize = 20;
        const skip = cursor ? Number.parseInt(cursor, 10) : 0;
        const query = { "properties.post-type": "like" };
        const docs = await collections.posts
          .find(query)
          .sort({ "properties.published": -1 })
          .skip(skip)
          .limit(pageSize)
          .toArray();
        const total = await collections.posts.countDocuments(query);

        const items = docs
          .map((d) => {
            const likeOf = d.properties?.["like-of"];
            return likeOf ? new URL(likeOf) : null;
          })
          .filter(Boolean);

        return {
          items,
          nextCursor:
            skip + pageSize < total ? String(skip + pageSize) : null,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      if (identifier !== handle) return 0;
      if (!collections.posts) return 0;
      return await collections.posts.countDocuments({
        "properties.post-type": "like",
      });
    })
    .setFirstCursor(async () => "0");
}

function setupFeatured(federation, mountPath, handle, collections, publicationUrl) {
  federation.setFeaturedDispatcher(
    `${mountPath}/users/{identifier}/featured`,
    async (ctx, identifier) => {
      if (identifier !== handle) return null;
      if (!collections.ap_featured) return { items: [] };

      const docs = await collections.ap_featured
        .find()
        .sort({ pinnedAt: -1 })
        .toArray();

      // Convert pinned post URLs to Fedify Note/Article objects
      const items = [];
      for (const doc of docs) {
        if (!collections.posts) continue;
        const post = await collections.posts.findOne({
          "properties.url": doc.postUrl,
        });
        if (!post) continue;
        const actorUrl = ctx.getActorUri(identifier).href;
        const activity = jf2ToAS2Activity(
          post.properties,
          actorUrl,
          publicationUrl,
        );
        if (activity instanceof Create) {
          const obj = await activity.getObject();
          if (obj) items.push(obj);
        }
      }

      return { items };
    },
  );
}

function setupFeaturedTags(federation, mountPath, handle, collections, publicationUrl) {
  federation.setFeaturedTagsDispatcher(
    `${mountPath}/users/{identifier}/tags`,
    async (ctx, identifier) => {
      if (identifier !== handle) return null;
      if (!collections.ap_featured_tags) return { items: [] };

      const docs = await collections.ap_featured_tags
        .find()
        .sort({ addedAt: -1 })
        .toArray();

      const baseUrl = publicationUrl
        ? publicationUrl.replace(/\/$/, "")
        : ctx.url.origin;

      const items = docs.map(
        (doc) =>
          new Hashtag({
            name: `#${doc.tag}`,
            href: new URL(
              `/categories/${encodeURIComponent(doc.tag)}`,
              baseUrl,
            ),
          }),
      );

      return { items };
    },
  );
}

function setupOutbox(federation, mountPath, handle, collections) {
  federation
    .setOutboxDispatcher(
      `${mountPath}/users/{identifier}/outbox`,
      async (ctx, identifier, cursor) => {
        if (identifier !== handle) return null;

        const postsCollection = collections.posts;
        if (!postsCollection) return { items: [] };

        const pageSize = 20;
        const skip = cursor ? Number.parseInt(cursor, 10) : 0;
        const total = await postsCollection.countDocuments();

        const posts = await postsCollection
          .find()
          .sort({ "properties.published": -1 })
          .skip(skip)
          .limit(pageSize)
          .toArray();

        const { jf2ToAS2Activity } = await import("./jf2-to-as2.js");
        const items = posts
          .map((post) => {
            try {
              return jf2ToAS2Activity(
                post.properties,
                ctx.getActorUri(identifier).href,
                collections._publicationUrl,
              );
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        return {
          items,
          nextCursor:
            skip + pageSize < total ? String(skip + pageSize) : null,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      if (identifier !== handle) return 0;
      const postsCollection = collections.posts;
      if (!postsCollection) return 0;
      return await postsCollection.countDocuments();
    })
    .setFirstCursor(async () => "0");
}

function setupObjectDispatchers(federation, mountPath, handle, collections, publicationUrl) {
  // Shared lookup: find post by URL path, convert to Fedify Note/Article
  async function resolvePost(ctx, id) {
    if (!collections.posts || !publicationUrl) return null;
    const postUrl = `${publicationUrl.replace(/\/$/, "")}/${id}`;
    const post = await collections.posts.findOne({ "properties.url": postUrl });
    if (!post) return null;
    const actorUrl = ctx.getActorUri(handle).href;
    const activity = jf2ToAS2Activity(post.properties, actorUrl, publicationUrl);
    // Only Create activities wrap Note/Article objects
    if (!(activity instanceof Create)) return null;
    return await activity.getObject();
  }

  // Note dispatcher — handles note, reply, bookmark, jam, rsvp, checkin
  federation.setObjectDispatcher(
    Note,
    `${mountPath}/objects/note/{+id}`,
    async (ctx, { id }) => {
      const obj = await resolvePost(ctx, id);
      return obj instanceof Note ? obj : null;
    },
  );

  // Article dispatcher
  federation.setObjectDispatcher(
    Article,
    `${mountPath}/objects/article/{+id}`,
    async (ctx, { id }) => {
      const obj = await resolvePost(ctx, id);
      return obj instanceof Article ? obj : null;
    },
  );
}

// --- Helpers ---

async function getProfile(collections) {
  const doc = await collections.ap_profile.findOne({});
  return doc || {};
}

/**
 * Import a PKCS#8 PEM private key using Web Crypto API.
 * Fedify's importPem only handles PKCS#1, but Node.js crypto generates PKCS#8.
 */
async function importPkcs8Pem(pem) {
  const lines = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(lines), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"],
  );
}

function guessImageMediaType(url) {
  const ext = url.split(".").pop()?.toLowerCase();
  const types = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return types[ext] || "image/jpeg";
}
