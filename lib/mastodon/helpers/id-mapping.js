/**
 * Deterministic ID mapping for Mastodon Client API.
 *
 * Local accounts use MongoDB _id.toString().
 * Remote actors use sha256(actorUrl).slice(0, 24) for stable IDs
 * without requiring a dedicated accounts collection.
 */
import crypto from "node:crypto";

/**
 * Generate a deterministic ID for a remote actor URL.
 * @param {string} actorUrl - The remote actor's URL
 * @returns {string} 24-character hex ID
 */
export function remoteActorId(actorUrl) {
  return crypto.createHash("sha256").update(actorUrl).digest("hex").slice(0, 24);
}

/**
 * Get the Mastodon API ID for an account.
 * @param {object} actor - Actor object (local profile or remote author)
 * @param {boolean} isLocal - Whether this is the local profile
 * @returns {string}
 */
export function accountId(actor, isLocal = false) {
  if (isLocal && actor._id) {
    return actor._id.toString();
  }
  // Remote actors: use URL-based deterministic hash
  const url = actor.url || actor.actorUrl || "";
  return url ? remoteActorId(url) : "0";
}
