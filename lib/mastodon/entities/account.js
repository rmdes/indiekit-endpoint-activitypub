/**
 * Account entity serializer for Mastodon Client API.
 *
 * Converts local profile (ap_profile) and remote actor objects
 * (from timeline author, follower/following docs) into the
 * Mastodon Account JSON shape that masto.js expects.
 */
import { accountId } from "../helpers/id-mapping.js";
import { sanitizeHtml, stripHtml } from "./sanitize.js";

/**
 * Serialize an actor as a Mastodon Account entity.
 *
 * Handles two shapes:
 * - Local profile: { _id, name, summary, url, icon, image, actorType,
 *     manuallyApprovesFollowers, attachments, createdAt, ... }
 * - Remote author (from timeline): { name, url, photo, handle, emojis, bot }
 * - Follower/following doc: { actorUrl, name, handle, avatar, ... }
 *
 * @param {object} actor - Actor document (profile, author, or follower)
 * @param {object} options
 * @param {string} options.baseUrl - Server base URL
 * @param {boolean} [options.isLocal=false] - Whether this is the local user
 * @param {string} [options.handle] - Local actor handle (for local accounts)
 * @returns {object} Mastodon Account entity
 */
export function serializeAccount(actor, { baseUrl, isLocal = false, handle = "" }) {
  if (!actor) {
    return null;
  }

  const id = accountId(actor, isLocal);

  // Resolve username and acct
  let username;
  let acct;
  if (isLocal) {
    username = handle || extractUsername(actor.url) || "user";
    acct = username; // local accounts use bare username
  } else {
    // Remote: extract from handle (@user@domain) or URL
    const remoteHandle = actor.handle || "";
    if (remoteHandle.startsWith("@")) {
      username = remoteHandle.split("@")[1] || "";
      acct = remoteHandle.slice(1); // strip leading @
    } else if (remoteHandle.includes("@")) {
      username = remoteHandle.split("@")[0];
      acct = remoteHandle;
    } else {
      username = extractUsername(actor.url || actor.actorUrl) || "unknown";
      const domain = extractDomain(actor.url || actor.actorUrl);
      acct = domain ? `${username}@${domain}` : username;
    }
  }

  // Resolve display name
  const displayName = actor.name || actor.displayName || username || "";

  // Resolve URLs for avatar and header
  const avatarUrl =
    actor.icon || actor.avatarUrl || actor.photo || actor.avatar || "";
  const headerUrl = actor.image || actor.bannerUrl || "";

  // Resolve URL
  const url = actor.url || actor.actorUrl || "";

  // Resolve note/summary
  const note = actor.summary || "";

  // Bot detection
  const bot =
    actor.bot === true ||
    actor.actorType === "Service" ||
    actor.actorType === "Application";

  // Profile fields from attachments
  const fields = (actor.attachments || actor.fields || []).map((f) => ({
    name: f.name || "",
    value: sanitizeHtml(f.value || ""),
    verified_at: null,
  }));

  // Custom emojis
  const emojis = (actor.emojis || []).map((e) => ({
    shortcode: e.shortcode || "",
    url: e.url || "",
    static_url: e.url || "",
    visible_in_picker: true,
  }));

  return {
    id,
    username,
    acct,
    url,
    display_name: displayName,
    note: sanitizeHtml(note),
    avatar: avatarUrl || `${baseUrl}/images/default-avatar.svg`,
    avatar_static: avatarUrl || `${baseUrl}/images/default-avatar.svg`,
    header: headerUrl || "",
    header_static: headerUrl || "",
    locked: actor.manuallyApprovesFollowers || false,
    fields,
    emojis,
    bot,
    group: actor.actorType === "Group" || false,
    discoverable: true,
    noindex: false,
    created_at: actor.createdAt || new Date().toISOString(),
    last_status_at: actor.lastStatusAt || null,
    statuses_count: actor.statusesCount || 0,
    followers_count: actor.followersCount || 0,
    following_count: actor.followingCount || 0,
    moved: actor.movedTo || null,
    suspended: false,
    limited: false,
    memorial: false,
    roles: [],
    hide_collections: false,
  };
}

/**
 * Serialize the local profile as a CredentialAccount (includes source + role).
 *
 * @param {object} profile - ap_profile document
 * @param {object} options
 * @param {string} options.baseUrl - Server base URL
 * @param {string} options.handle - Local actor handle
 * @param {object} [options.counts] - { statuses, followers, following }
 * @returns {object} Mastodon CredentialAccount entity
 */
export function serializeCredentialAccount(profile, { baseUrl, handle, counts = {} }) {
  const account = serializeAccount(profile, {
    baseUrl,
    isLocal: true,
    handle,
  });

  // Add counts if provided
  account.statuses_count = counts.statuses || 0;
  account.followers_count = counts.followers || 0;
  account.following_count = counts.following || 0;

  // CredentialAccount extensions
  account.source = {
    privacy: "public",
    sensitive: false,
    language: "",
    note: stripHtml(profile.summary || ""),
    fields: (profile.attachments || []).map((f) => ({
      name: f.name || "",
      value: f.value || "",
      verified_at: null,
    })),
    follow_requests_count: 0,
  };

  account.role = {
    id: "-99",
    name: "",
    permissions: "0",
    color: "",
    highlighted: false,
  };

  return account;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract username from a URL path.
 * Handles /@username, /users/username patterns.
 */
function extractUsername(url) {
  if (!url) return "";
  try {
    const { pathname } = new URL(url);
    const atMatch = pathname.match(/\/@([^/]+)/);
    if (atMatch) return atMatch[1];
    const usersMatch = pathname.match(/\/users\/([^/]+)/);
    if (usersMatch) return usersMatch[1];
    return "";
  } catch {
    return "";
  }
}

/**
 * Extract domain from a URL.
 */
function extractDomain(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
