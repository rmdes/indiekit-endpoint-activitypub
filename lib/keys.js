import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";

const generateKeyPairAsync = promisify(generateKeyPair);

/**
 * Get or create an RSA 2048-bit key pair for the ActivityPub actor.
 * Keys are stored in the ap_keys MongoDB collection so they persist
 * across server restarts — a stable key pair is essential for federation
 * since remote servers cache the public key for signature verification.
 *
 * @param {Collection} collection - MongoDB ap_keys collection
 * @param {string} actorUrl - Actor URL (used as the key document identifier)
 * @returns {Promise<{publicKeyPem: string, privateKeyPem: string}>}
 */
export async function getOrCreateKeyPair(collection, actorUrl) {
  const existing = await collection.findOne({ actorUrl });
  if (existing) {
    return {
      publicKeyPem: existing.publicKeyPem,
      privateKeyPem: existing.privateKeyPem,
    };
  }

  const { publicKey, privateKey } = await generateKeyPairAsync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  await collection.insertOne({
    actorUrl,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    createdAt: new Date().toISOString(),
  });

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}
