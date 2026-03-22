/**
 * Direct Follow/Undo(Follow) for servers that reject Fedify's LD Signatures.
 *
 * tags.pub's activitypub-bot uses the `activitystrea.ms` AS2 parser, which
 * rejects the `https://w3id.org/identity/v1` JSON-LD context that Fedify 2.0
 * adds for RsaSignature2017. This module sends Follow/Undo(Follow) activities
 * with a minimal body (no LD Sig, no Data Integrity Proof) signed with
 * draft-cavage HTTP Signatures.
 *
 * Upstream issue: https://github.com/social-web-foundation/tags.pub/issues/10
 *
 * @module direct-follow
 */

import crypto from "node:crypto";

/** Hostnames that need direct follow (bypass Fedify outbox pipeline) */
const DIRECT_FOLLOW_HOSTS = new Set(["tags.pub"]);

/**
 * Check if an actor URL requires direct follow delivery.
 * @param {string} actorUrl
 * @returns {boolean}
 */
export function needsDirectFollow(actorUrl) {
  try {
    return DIRECT_FOLLOW_HOSTS.has(new URL(actorUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Send a Follow activity directly with draft-cavage HTTP Signatures.
 * @param {object} options
 * @param {string} options.actorUri - Our actor URI
 * @param {string} options.targetActorUrl - Remote actor URL to follow
 * @param {string} options.inboxUrl - Remote actor's inbox URL
 * @param {string} options.keyId - Our key ID (e.g. ...#main-key)
 * @param {CryptoKey} options.privateKey - RSA private key for signing
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function sendDirectFollow({
  actorUri,
  targetActorUrl,
  inboxUrl,
  keyId,
  privateKey,
}) {
  const body = JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Follow",
    actor: actorUri,
    object: targetActorUrl,
    id: `${actorUri.replace(/\/$/, "")}/#Follow/${crypto.randomUUID()}`,
  });

  return _signAndSend(inboxUrl, body, keyId, privateKey);
}

/**
 * Send an Undo(Follow) activity directly with draft-cavage HTTP Signatures.
 * @param {object} options
 * @param {string} options.actorUri - Our actor URI
 * @param {string} options.targetActorUrl - Remote actor URL to unfollow
 * @param {string} options.inboxUrl - Remote actor's inbox URL
 * @param {string} options.keyId - Our key ID (e.g. ...#main-key)
 * @param {CryptoKey} options.privateKey - RSA private key for signing
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function sendDirectUnfollow({
  actorUri,
  targetActorUrl,
  inboxUrl,
  keyId,
  privateKey,
}) {
  const body = JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Undo",
    actor: actorUri,
    object: {
      type: "Follow",
      actor: actorUri,
      object: targetActorUrl,
    },
    id: `${actorUri.replace(/\/$/, "")}/#Undo/${crypto.randomUUID()}`,
  });

  return _signAndSend(inboxUrl, body, keyId, privateKey);
}

/**
 * Sign a POST request with draft-cavage HTTP Signatures and send it.
 * @private
 */
async function _signAndSend(inboxUrl, body, keyId, privateKey) {
  const url = new URL(inboxUrl);
  const date = new Date().toUTCString();

  // Compute SHA-256 digest of the body
  const digestRaw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const digest = "SHA-256=" + Buffer.from(digestRaw).toString("base64");

  // Build draft-cavage signing string
  const signingString = [
    `(request-target): post ${url.pathname}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");

  // Sign with RSA-SHA256
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingString),
  );
  const signatureB64 = Buffer.from(signature).toString("base64");

  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="(request-target) host date digest"`,
    `signature="${signatureB64}"`,
  ].join(",");

  try {
    const response = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/activity+json",
        Date: date,
        Digest: digest,
        Host: url.host,
        Signature: signatureHeader,
      },
      body,
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    const errorBody = await response.text().catch(() => "");
    let detail = errorBody;
    try {
      detail = JSON.parse(errorBody).detail || errorBody;
    } catch {
      // not JSON
    }
    return {
      ok: false,
      status: response.status,
      error: `${response.status} ${response.statusText}: ${detail}`,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
