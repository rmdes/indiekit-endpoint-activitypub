/**
 * Federation handler — the core glue for ActivityPub protocol operations.
 *
 * Handles HTTP Signature signing/verification, inbox dispatch, outbox
 * serving, collection endpoints, and outbound activity delivery.
 *
 * Uses Node's crypto for HTTP Signatures rather than Fedify's middleware,
 * because the plugin owns its own Express routes and Fedify's
 * integrateFederation() expects to own the request lifecycle.
 * Fedify is used for utility functions (e.g. lookupWebFinger in migration).
 */

import { createHash, createSign, createVerify } from "node:crypto";
import { getOrCreateKeyPair } from "./keys.js";
import { jf2ToActivityStreams, resolvePostUrl } from "./jf2-to-as2.js";
import { processInboxActivity } from "./inbox.js";

/**
 * Create the federation handler used by all AP route handlers in index.js.
 *
 * @param {object} options
 * @param {string} options.actorUrl - Actor URL (e.g. "https://rmendes.net/")
 * @param {string} options.publicationUrl - Publication base URL with trailing slash
 * @param {string} options.mountPath - Plugin mount path (e.g. "/activitypub")
 * @param {object} options.actorConfig - { handle, name, summary, icon }
 * @param {string} options.alsoKnownAs - Previous account URL for migration
 * @param {object} options.collections - MongoDB collections
 * @returns {object} Handler with handleInbox, handleOutbox, handleFollowers, handleFollowing, deliverToFollowers
 */
export function createFederationHandler(options) {
  const {
    actorUrl,
    publicationUrl,
    mountPath,
    collections,
    storeRawActivities = false,
  } = options;

  const baseUrl = publicationUrl.replace(/\/$/, "");
  const keyId = `${actorUrl}#main-key`;

  // Lazy-loaded key pair — fetched from MongoDB on first use
  let _keyPair = null;
  async function getKeyPair() {
    if (!_keyPair) {
      _keyPair = await getOrCreateKeyPair(collections.ap_keys, actorUrl);
    }
    return _keyPair;
  }

  return {
    /**
     * POST /inbox — receive and process incoming activities.
     */
    async handleInbox(request, response) {
      let body;
      try {
        const raw =
          request.body instanceof Buffer
            ? request.body
            : Buffer.from(request.body || "");
        body = JSON.parse(raw.toString("utf-8"));
      } catch {
        return response.status(400).json({ error: "Invalid JSON" });
      }

      // Verify HTTP Signature
      const rawBuffer =
        request.body instanceof Buffer
          ? request.body
          : Buffer.from(request.body || "");
      const signatureValid = await verifyHttpSignature(request, rawBuffer);
      if (!signatureValid) {
        return response.status(401).json({ error: "Invalid HTTP signature" });
      }

      // Dispatch to inbox handlers
      try {
        await processInboxActivity(body, collections, {
          actorUrl,
          storeRawActivities,
          async deliverActivity(activity, inboxUrl) {
            const keyPair = await getKeyPair();
            return sendSignedActivity(
              activity,
              inboxUrl,
              keyPair.privateKeyPem,
              keyId,
            );
          },
        });
        return response.status(202).json({ status: "accepted" });
      } catch (error) {
        console.error("[ActivityPub] Inbox processing error:", error);
        return response
          .status(500)
          .json({ error: "Failed to process activity" });
      }
    },

    /**
     * GET /outbox — serve published posts as an OrderedCollection.
     */
    async handleOutbox(request, response) {
      const { application } = request.app.locals;
      const postsCollection = application?.collections?.get("posts");

      if (!postsCollection) {
        response.set("Content-Type", "application/activity+json");
        return response.json(emptyCollection(`${baseUrl}${mountPath}/outbox`));
      }

      const page = Number.parseInt(request.query.page, 10) || 0;
      const pageSize = 20;
      const totalItems = await postsCollection.countDocuments();

      const posts = await postsCollection
        .find()
        .sort({ "properties.published": -1 })
        .skip(page * pageSize)
        .limit(pageSize)
        .toArray();

      const orderedItems = posts.map((post) =>
        jf2ToActivityStreams(post.properties, actorUrl, publicationUrl),
      );

      response.set("Content-Type", "application/activity+json");
      return response.json({
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "OrderedCollection",
        id: `${baseUrl}${mountPath}/outbox`,
        totalItems,
        orderedItems,
      });
    },

    /**
     * GET /followers — serve followers as an OrderedCollection.
     */
    async handleFollowers(request, response) {
      const docs = await collections.ap_followers
        .find()
        .sort({ followedAt: -1 })
        .toArray();

      response.set("Content-Type", "application/activity+json");
      return response.json({
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "OrderedCollection",
        id: `${baseUrl}${mountPath}/followers`,
        totalItems: docs.length,
        orderedItems: docs.map((f) => f.actorUrl),
      });
    },

    /**
     * GET /following — serve following as an OrderedCollection.
     */
    async handleFollowing(request, response) {
      const docs = await collections.ap_following
        .find()
        .sort({ followedAt: -1 })
        .toArray();

      response.set("Content-Type", "application/activity+json");
      return response.json({
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "OrderedCollection",
        id: `${baseUrl}${mountPath}/following`,
        totalItems: docs.length,
        orderedItems: docs.map((f) => f.actorUrl),
      });
    },

    /**
     * Deliver a post to all followers' inboxes.
     * Called by the syndicator when a post is published with AP ticked.
     *
     * @param {object} properties - JF2 post properties
     * @param {object} publication - Indiekit publication object
     * @returns {string} The ActivityPub object URL (stored as syndication URL)
     */
    async deliverToFollowers(properties) {
      const keyPair = await getKeyPair();

      const activity = jf2ToActivityStreams(
        properties,
        actorUrl,
        publicationUrl,
      );

      // Set an explicit activity ID
      const postUrl = resolvePostUrl(properties.url, publicationUrl);
      activity.id = `${postUrl}#activity`;

      // Gather unique inbox URLs (prefer sharedInbox for efficiency)
      const followers = await collections.ap_followers.find().toArray();
      const inboxes = new Set();
      for (const follower of followers) {
        inboxes.add(follower.sharedInbox || follower.inbox);
      }

      // Deliver to each unique inbox
      let delivered = 0;
      for (const inboxUrl of inboxes) {
        if (!inboxUrl) continue;
        const ok = await sendSignedActivity(
          activity,
          inboxUrl,
          keyPair.privateKeyPem,
          keyId,
        );
        if (ok) delivered++;
      }

      // Log outbound activity
      await collections.ap_activities.insertOne({
        direction: "outbound",
        type: activity.type,
        actorUrl,
        objectUrl: activity.object?.id || activity.object,
        summary: `Delivered ${activity.type} to ${delivered}/${inboxes.size} inboxes`,
        receivedAt: new Date().toISOString(),
        ...(storeRawActivities ? { raw: activity } : {}),
      });

      // Return the object URL — Indiekit stores this in the post's syndication array
      return activity.object?.id || activity.object?.url || postUrl;
    },
  };
}

// --- HTTP Signature implementation ---

/**
 * Compute SHA-256 digest of a body buffer for the Digest header.
 */
function computeDigest(body) {
  const hash = createHash("sha256").update(body).digest("base64");
  return `SHA-256=${hash}`;
}

/**
 * Sign and send an activity to a remote inbox.
 *
 * @param {object} activity - ActivityStreams activity object
 * @param {string} inboxUrl - Target inbox URL
 * @param {string} privateKeyPem - PEM-encoded RSA private key
 * @param {string} keyId - Key ID URL (e.g. "https://rmendes.net/#main-key")
 * @returns {Promise<boolean>} true if delivery succeeded
 */
async function sendSignedActivity(activity, inboxUrl, privateKeyPem, keyId) {
  const body = JSON.stringify(activity);
  const bodyBuffer = Buffer.from(body);
  const url = new URL(inboxUrl);
  const date = new Date().toUTCString();
  const digest = computeDigest(bodyBuffer);

  // Build the signing string per HTTP Signatures spec
  const signingString = [
    `(request-target): post ${url.pathname}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");

  const signer = createSign("sha256");
  signer.update(signingString);
  const signature = signer.sign(privateKeyPem, "base64");

  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="(request-target) host date digest"`,
    `signature="${signature}"`,
  ].join(",");

  try {
    const response = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/activity+json",
        Host: url.host,
        Date: date,
        Digest: digest,
        Signature: signatureHeader,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok || response.status === 202;
  } catch (error) {
    console.error(
      `[ActivityPub] Delivery to ${inboxUrl} failed:`,
      error.message,
    );
    return false;
  }
}

/**
 * Verify the HTTP Signature on an incoming request.
 *
 * 1. Parse the Signature header
 * 2. Fetch the remote actor's public key via keyId
 * 3. Reconstruct the signing string
 * 4. Verify with RSA-SHA256
 *
 * @param {object} request - Express request object
 * @param {Buffer} rawBody - Raw request body for digest verification
 * @returns {Promise<boolean>} true if signature is valid
 */
async function verifyHttpSignature(request, rawBody) {
  const sigHeader = request.headers.signature;
  if (!sigHeader) return false;

  // Parse signature header: keyId="...",algorithm="...",headers="...",signature="..."
  const params = {};
  for (const part of sigHeader.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim().replace(/^"|"$/g, "");
    params[key] = value;
  }

  const { keyId: remoteKeyId, headers: headerNames, signature } = params;
  if (!remoteKeyId || !headerNames || !signature) return false;

  // Verify Digest header matches body
  if (request.headers.digest) {
    const expectedDigest = computeDigest(rawBody);
    if (request.headers.digest !== expectedDigest) return false;
  }

  // Fetch the remote actor document to get their public key
  const publicKeyPem = await fetchRemotePublicKey(remoteKeyId);
  if (!publicKeyPem) return false;

  // Reconstruct signing string from the listed headers
  const headerList = headerNames.split(" ");
  const signingParts = headerList.map((h) => {
    if (h === "(request-target)") {
      const method = request.method.toLowerCase();
      const path = request.originalUrl || request.url;
      return `(request-target): ${method} ${path}`;
    }
    if (h === "host") {
      return `host: ${request.headers.host || request.hostname}`;
    }
    return `${h}: ${request.headers[h]}`;
  });
  const signingString = signingParts.join("\n");

  // Verify
  try {
    const verifier = createVerify("sha256");
    verifier.update(signingString);
    return verifier.verify(publicKeyPem, signature, "base64");
  } catch {
    return false;
  }
}

/**
 * Fetch a remote actor's public key by key ID URL.
 * The keyId is typically "https://remote.example/users/alice#main-key"
 * — we fetch the actor document (without fragment) and extract publicKey.
 */
async function fetchRemotePublicKey(keyIdUrl) {
  try {
    // Remove fragment to get the actor document URL
    const actorUrl = keyIdUrl.split("#")[0];

    const response = await fetch(actorUrl, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const doc = await response.json();

    // Key may be at doc.publicKey.publicKeyPem or in a publicKey array
    if (doc.publicKey) {
      const key = Array.isArray(doc.publicKey)
        ? doc.publicKey.find((k) => k.id === keyIdUrl) || doc.publicKey[0]
        : doc.publicKey;
      return key?.publicKeyPem || null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build an empty OrderedCollection response.
 */
function emptyCollection(id) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "OrderedCollection",
    id,
    totalItems: 0,
    orderedItems: [],
  };
}
