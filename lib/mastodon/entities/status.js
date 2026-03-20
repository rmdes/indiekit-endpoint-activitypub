/**
 * Status entity serializer for Mastodon Client API.
 *
 * Converts ap_timeline documents into the Mastodon Status JSON shape.
 *
 * CORRECTED field mappings (based on actual extractObjectData output):
 *   content    <- content.html (NOT contentHtml)
 *   uri        <- uid (NOT activityUrl)
 *   account    <- author { name, url, photo, handle, emojis, bot }
 *   media      <- photo[] + video[] + audio[] (NOT single attachments[])
 *   card       <- linkPreviews[0] (NOT single card)
 *   tags       <- category[] (NOT tags[])
 *   counts     <- counts.boosts, counts.likes, counts.replies
 *   boost      <- type:"boost" + boostedBy (flat, NOT nested sharedItem)
 */
import { serializeAccount } from "./account.js";
import { sanitizeHtml } from "./sanitize.js";

// Module-level defaults set once at startup via setLocalIdentity()
let _localPublicationUrl = "";
let _localHandle = "";

/**
 * Set the local identity for own-post detection.
 * Called once during plugin init.
 * @param {string} publicationUrl - e.g. "https://rmendes.net/"
 * @param {string} handle - e.g. "rick"
 */
export function setLocalIdentity(publicationUrl, handle) {
  _localPublicationUrl = publicationUrl;
  _localHandle = handle;
}

/**
 * Serialize an ap_timeline document as a Mastodon Status entity.
 *
 * @param {object} item - ap_timeline document
 * @param {object} options
 * @param {string} options.baseUrl - Server base URL
 * @param {Set<string>} [options.favouritedIds] - UIDs the user has liked
 * @param {Set<string>} [options.rebloggedIds] - UIDs the user has boosted
 * @param {Set<string>} [options.bookmarkedIds] - UIDs the user has bookmarked
 * @param {Set<string>} [options.pinnedIds] - UIDs the user has pinned
 * @returns {object} Mastodon Status entity
 */
export function serializeStatus(item, { baseUrl, favouritedIds, rebloggedIds, bookmarkedIds, pinnedIds }) {
  if (!item) return null;

  const id = item._id.toString();
  const uid = item.uid || "";
  const url = item.url || uid;

  // Handle boosts — reconstruct nested reblog wrapper
  if (item.type === "boost" && item.boostedBy) {
    // The outer status represents the boost action
    // The inner status is the original post (the item itself minus boost metadata)
    const innerItem = { ...item, type: "note", boostedBy: undefined, boostedAt: undefined };
    const innerStatus = serializeStatus(innerItem, {
      baseUrl,
      favouritedIds,
      rebloggedIds,
      bookmarkedIds,
      pinnedIds,
    });

    return {
      id,
      created_at: item.boostedAt || item.createdAt || new Date().toISOString(),
      in_reply_to_id: null,
      in_reply_to_account_id: null,
      sensitive: false,
      spoiler_text: "",
      visibility: item.visibility || "public",
      language: null,
      uri: uid,
      url,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      edited_at: null,
      favourited: false,
      reblogged: rebloggedIds?.has(uid) || false,
      muted: false,
      bookmarked: false,
      pinned: false,
      content: "",
      filtered: null,
      reblog: innerStatus,
      application: null,
      account: serializeAccount(item.boostedBy, { baseUrl }),
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
      card: null,
      poll: null,
    };
  }

  // Regular status (note, article, question)
  const content = item.content?.html || item.content?.text || "";
  const spoilerText = item.summary || "";
  const sensitive = item.sensitive || false;
  const visibility = item.visibility || "public";
  const language = item.language || null;
  const published = item.published || item.createdAt || new Date().toISOString();
  const editedAt = item.updated || item.updatedAt || null;

  // Media attachments — merge photo, video, audio arrays
  const mediaAttachments = [];
  let attachmentCounter = 0;

  if (item.photo?.length > 0) {
    for (const p of item.photo) {
      mediaAttachments.push({
        id: `${id}-${attachmentCounter++}`,
        type: "image",
        url: typeof p === "string" ? p : p.url,
        preview_url: typeof p === "string" ? p : p.url,
        remote_url: typeof p === "string" ? p : p.url,
        text_url: null,
        meta: buildImageMeta(p),
        description: typeof p === "object" ? p.alt || "" : "",
        blurhash: null,
      });
    }
  }

  if (item.video?.length > 0) {
    for (const v of item.video) {
      mediaAttachments.push({
        id: `${id}-${attachmentCounter++}`,
        type: "video",
        url: typeof v === "string" ? v : v.url,
        preview_url: typeof v === "string" ? v : v.url,
        remote_url: typeof v === "string" ? v : v.url,
        text_url: null,
        meta: null,
        description: typeof v === "object" ? v.alt || "" : "",
        blurhash: null,
      });
    }
  }

  if (item.audio?.length > 0) {
    for (const a of item.audio) {
      mediaAttachments.push({
        id: `${id}-${attachmentCounter++}`,
        type: "audio",
        url: typeof a === "string" ? a : a.url,
        preview_url: typeof a === "string" ? a : a.url,
        remote_url: typeof a === "string" ? a : a.url,
        text_url: null,
        meta: null,
        description: typeof a === "object" ? a.alt || "" : "",
        blurhash: null,
      });
    }
  }

  // Link preview -> card
  const card = serializeCard(item.linkPreviews?.[0]);

  // Tags from category[]
  const tags = (item.category || []).map((tag) => ({
    name: tag,
    url: `${baseUrl}/tags/${encodeURIComponent(tag)}`,
  }));

  // Mentions
  const mentions = (item.mentions || []).map((m) => ({
    id: "0", // We don't have stable IDs for mentioned accounts
    username: m.name || "",
    url: m.url || "",
    acct: m.name || "",
  }));

  // Custom emojis
  const emojis = (item.emojis || []).map((e) => ({
    shortcode: e.shortcode || "",
    url: e.url || "",
    static_url: e.url || "",
    visible_in_picker: true,
  }));

  // Counts
  const repliesCount = item.counts?.replies ?? 0;
  const reblogsCount = item.counts?.boosts ?? 0;
  const favouritesCount = item.counts?.likes ?? 0;

  // Poll
  const poll = serializePoll(item, id);

  // Interaction state
  const favourited = favouritedIds?.has(uid) || false;
  const reblogged = rebloggedIds?.has(uid) || false;
  const bookmarked = bookmarkedIds?.has(uid) || false;
  const pinned = pinnedIds?.has(uid) || false;

  return {
    id,
    created_at: published,
    in_reply_to_id: item.inReplyTo ? null : null, // TODO: resolve to local ID
    in_reply_to_account_id: null, // TODO: resolve
    sensitive,
    spoiler_text: spoilerText,
    visibility,
    language,
    uri: uid,
    url,
    replies_count: repliesCount,
    reblogs_count: reblogsCount,
    favourites_count: favouritesCount,
    edited_at: editedAt || null,
    favourited,
    reblogged,
    muted: false,
    bookmarked,
    pinned,
    content: sanitizeHtml(content),
    filtered: null,
    reblog: null,
    application: null,
    account: item.author
      ? serializeAccount(item.author, {
          baseUrl,
          isLocal: !!(_localPublicationUrl && item.author.url === _localPublicationUrl),
          handle: _localHandle,
        })
      : null,
    media_attachments: mediaAttachments,
    mentions,
    tags,
    emojis,
    card,
    poll,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Serialize a linkPreview object as a Mastodon PreviewCard.
 */
function serializeCard(preview) {
  if (!preview) return null;

  return {
    url: preview.url || "",
    title: preview.title || "",
    description: preview.description || "",
    type: "link",
    author_name: "",
    author_url: "",
    provider_name: preview.domain || "",
    provider_url: "",
    html: "",
    width: 0,
    height: 0,
    image: preview.image || null,
    embed_url: "",
    blurhash: null,
    language: null,
    published_at: null,
  };
}

/**
 * Build image meta object for media attachments.
 */
function buildImageMeta(photo) {
  if (typeof photo === "string") return null;
  if (!photo.width && !photo.height) return null;

  return {
    original: {
      width: photo.width || 0,
      height: photo.height || 0,
      size: photo.width && photo.height ? `${photo.width}x${photo.height}` : null,
      aspect: photo.width && photo.height ? photo.width / photo.height : null,
    },
  };
}

/**
 * Serialize poll data from a timeline item.
 */
function serializePoll(item, statusId) {
  if (!item.pollOptions?.length) return null;

  const totalVotes = item.pollOptions.reduce((sum, o) => sum + (o.votes || 0), 0);

  return {
    id: statusId,
    expires_at: item.pollEndTime || null,
    expired: item.pollClosed || false,
    multiple: false,
    votes_count: totalVotes,
    voters_count: item.votersCount || null,
    options: item.pollOptions.map((o) => ({
      title: o.name || "",
      votes_count: o.votes || 0,
    })),
    emojis: [],
    voted: false,
    own_votes: [],
  };
}
