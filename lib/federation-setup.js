/**
 * Fedify Federation setup — configures the Federation instance with all
 * dispatchers, inbox listeners, and collection handlers.
 *
 * This replaces the hand-rolled federation.js, actor.js, keys.js, webfinger.js,
 * and inbox.js with Fedify's battle-tested implementations.
 */

import { Temporal } from "@js-temporal/polyfill";
import {
  Endpoints,
  Image,
  InProcessMessageQueue,
  Person,
  PropertyValue,
  createFederation,
  importSpki,
} from "@fedify/fedify";
import { MongoKvStore } from "./kv-store.js";
import { registerInboxListeners } from "./inbox-listeners.js";

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
export function setupFederation(options) {
  const {
    collections,
    mountPath,
    handle,
    storeRawActivities = false,
  } = options;

  const federation = createFederation({
    kv: new MongoKvStore(collections.ap_kv),
    queue: new InProcessMessageQueue(),
  });

  // --- Actor dispatcher ---
  federation
    .setActorDispatcher(
      `${mountPath}/users/{identifier}`,
      async (ctx, identifier) => {
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
          personOptions.assertionMethod = keyPairs[0].multikey;
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

        return new Person(personOptions);
      },
    )
    .setKeyPairsDispatcher(async (ctx, identifier) => {
      if (identifier !== handle) return [];

      const legacyKey = await collections.ap_keys.findOne({});
      if (legacyKey?.publicKeyPem && legacyKey?.privateKeyPem) {
        try {
          const publicKey = await importSpki(legacyKey.publicKeyPem, "RSA");
          const privateKey = await importPkcs8Pem(legacyKey.privateKeyPem);
          return [{ publicKey, privateKey }];
        } catch {
          console.warn(
            "[ActivityPub] Could not import legacy RSA keys, generating new key pairs",
          );
        }
      }

      return [];
    });

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

  // --- Collection dispatchers ---
  setupFollowers(federation, mountPath, handle, collections);
  setupFollowing(federation, mountPath, handle, collections);
  setupOutbox(federation, mountPath, handle, collections);

  // --- NodeInfo ---
  federation.setNodeInfoDispatcher("/nodeinfo/2.1", async () => {
    const postsCount = collections.posts
      ? await collections.posts.countDocuments()
      : 0;

    return {
      software: {
        name: "indiekit",
        version: { major: 1, minor: 0, patch: 0 },
      },
      protocols: ["activitypub"],
      usage: {
        users: { total: 1, activeMonth: 1, activeHalfyear: 1 },
        localPosts: postsCount,
        localComments: 0,
      },
    };
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
        const pageSize = 20;
        const skip = cursor ? Number.parseInt(cursor, 10) : 0;
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
