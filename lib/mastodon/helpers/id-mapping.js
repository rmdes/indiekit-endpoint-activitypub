/**
 * Deterministic ID mapping for Mastodon Client API.
 *
 * All accounts (local and remote) use sha256(actorUrl).slice(0, 24)
 * for stable, consistent IDs. This ensures verify_credentials and
 * status serialization produce the same ID for the local user,
 * even though the profile doc has _id but timeline author objects don't.
 */
import crypto from "node:crypto";

/**
 * Generate a deterministic ID for an actor URL.
 * @param {string} actorUrl - The actor's URL
 * @returns {string} 24-character hex ID
 */
export function remoteActorId(actorUrl) {
  return crypto.createHash("sha256").update(actorUrl).digest("hex").slice(0, 24);
}

/**
 * Get the Mastodon API ID for an account.
 * Uses URL-based hash for all accounts (local and remote) so the ID
 * is consistent regardless of whether the actor object has a MongoDB _id.
 * @param {object} actor - Actor object (local profile or remote author)
 * @param {boolean} _isLocal - Unused (kept for API compatibility)
 * @returns {string}
 */
export function accountId(actor, _isLocal = false) {
  const url = actor.url || actor.actorUrl || "";
  return url ? remoteActorId(url) : "0";
}
