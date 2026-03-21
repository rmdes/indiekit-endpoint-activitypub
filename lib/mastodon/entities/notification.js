/**
 * Notification entity serializer for Mastodon Client API.
 *
 * Converts ap_notifications documents into the Mastodon Notification JSON shape.
 *
 * Internal type -> Mastodon type mapping:
 *   like    -> favourite
 *   boost   -> reblog
 *   follow  -> follow
 *   reply   -> mention
 *   mention -> mention
 *   dm      -> mention (status will have visibility: "direct")
 */
import { serializeAccount } from "./account.js";
import { serializeStatus } from "./status.js";
import { encodeCursor } from "../helpers/pagination.js";

/**
 * Map internal notification types to Mastodon API types.
 */
const TYPE_MAP = {
  like: "favourite",
  boost: "reblog",
  follow: "follow",
  follow_request: "follow_request",
  reply: "mention",
  mention: "mention",
  dm: "mention",
  report: "admin.report",
};

/**
 * Serialize a notification document as a Mastodon Notification entity.
 *
 * @param {object} notif - ap_notifications document
 * @param {object} options
 * @param {string} options.baseUrl - Server base URL
 * @param {Map<string, object>} [options.statusMap] - Pre-fetched statuses keyed by targetUrl
 * @param {object} [options.interactionState] - { favouritedIds, rebloggedIds, bookmarkedIds }
 * @returns {object|null} Mastodon Notification entity
 */
export function serializeNotification(notif, { baseUrl, statusMap, interactionState }) {
  if (!notif) return null;

  const mastodonType = TYPE_MAP[notif.type] || notif.type;

  // Build the actor account from notification fields
  const account = serializeAccount(
    {
      name: notif.actorName,
      url: notif.actorUrl,
      photo: notif.actorPhoto,
      handle: notif.actorHandle,
    },
    { baseUrl },
  );

  // Resolve the associated status (for favourite, reblog, mention types)
  // For mention types, prefer the triggering post (notif.url) over the target post (notif.targetUrl)
  // because targetUrl for replies points to the user's OWN post being replied to
  let status = null;
  if (statusMap) {
    const isMentionType = mastodonType === "mention";
    const lookupUrl = isMentionType
      ? (notif.url || notif.targetUrl)
      : (notif.targetUrl || notif.url);

    if (lookupUrl) {
      const timelineItem = statusMap.get(lookupUrl);
      if (timelineItem) {
        status = serializeStatus(timelineItem, {
          baseUrl,
          favouritedIds: interactionState?.favouritedIds || new Set(),
          rebloggedIds: interactionState?.rebloggedIds || new Set(),
          bookmarkedIds: interactionState?.bookmarkedIds || new Set(),
          pinnedIds: new Set(),
        });
      }
    }
  }

  // For mentions/replies that don't have a matching timeline item,
  // construct a minimal status from the notification content
  if (!status && notif.content && (mastodonType === "mention")) {
    status = {
      id: notif._id.toString(),
      created_at: notif.published || notif.createdAt || new Date().toISOString(),
      in_reply_to_id: null,
      in_reply_to_account_id: null,
      sensitive: false,
      spoiler_text: "",
      visibility: notif.type === "dm" ? "direct" : "public",
      language: null,
      uri: notif.uid || "",
      url: notif.url || notif.targetUrl || notif.uid || "",
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      edited_at: null,
      favourited: false,
      reblogged: false,
      muted: false,
      bookmarked: false,
      pinned: false,
      content: notif.content?.html || notif.content?.text || "",
      filtered: null,
      reblog: null,
      application: null,
      account,
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
      card: null,
      poll: null,
    };
  }

  const createdAt = notif.published instanceof Date
    ? notif.published.toISOString()
    : notif.published || notif.createdAt || new Date().toISOString();

  return {
    id: encodeCursor(createdAt) || notif._id.toString(),
    type: mastodonType,
    created_at: createdAt,
    account,
    status,
  };
}
