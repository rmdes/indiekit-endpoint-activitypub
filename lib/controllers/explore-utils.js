/**
 * Shared utilities for explore controllers.
 *
 * Extracted to break the circular dependency between explore.js and tabs.js:
 *   - explore.js needs validateHashtag (was in tabs.js)
 *   - tabs.js needs validateInstance (was in explore.js)
 *   - hashtag-explore.js needs mapMastodonStatusToItem (was duplicated)
 */

import sanitizeHtml from "sanitize-html";
import { sanitizeContent } from "../timeline-store.js";

/**
 * Validate the instance parameter to prevent SSRF.
 * Only allows hostnames — no IPs, no localhost, no port numbers.
 * @param {string} instance - Raw instance parameter from query string
 * @returns {string|null} Validated hostname or null
 */
export function validateInstance(instance) {
  if (!instance || typeof instance !== "string") return null;

  try {
    const url = new URL(`https://${instance.trim()}`);
    const hostname = url.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(hostname) ||
      hostname.includes("[")
    ) {
      return null;
    }

    return hostname;
  } catch {
    return null;
  }
}

/**
 * Validates a hashtag value.
 * Returns the cleaned hashtag (leading # stripped) or null if invalid.
 *
 * Rules match Mastodon's hashtag character rules:
 *   - Alphanumeric + underscore only (\w+)
 *   - 1–100 characters after stripping leading #
 */
export function validateHashtag(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/^#+/, "");
  if (!cleaned || cleaned.length > 100) return null;
  if (!/^[\w]+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Map a Mastodon API status object to our timeline item format.
 * @param {object} status - Mastodon API status
 * @param {string} instance - Instance hostname (for handle construction)
 * @returns {object} Timeline item compatible with ap-item-card.njk
 */
export function mapMastodonStatusToItem(status, instance) {
  const account = status.account || {};
  const acct = account.acct || "";
  const handle = acct.includes("@") ? `@${acct}` : `@${acct}@${instance}`;

  const mentions = (status.mentions || []).map((m) => ({
    name: m.acct.includes("@") ? m.acct : `${m.acct}@${instance}`,
    url: m.url || "",
  }));

  const category = (status.tags || []).map((t) => t.name || "");

  const photo = [];
  const video = [];
  const audio = [];
  for (const att of status.media_attachments || []) {
    const url = att.url || att.remote_url || "";
    if (!url) continue;
    if (att.type === "image" || att.type === "gifv") {
      photo.push({
        url,
        alt: att.description || "",
        width: att.meta?.original?.width || null,
        height: att.meta?.original?.height || null,
        blurhash: att.blurhash || "",
        focus: att.meta?.focus || null,
      });
    } else if (att.type === "video") {
      video.push(url);
    } else if (att.type === "audio") {
      audio.push(url);
    }
  }

  // Extract custom emoji — Mastodon API provides emojis on both status and account
  const emojis = (status.emojis || [])
    .filter((e) => e.shortcode && e.url)
    .map((e) => ({ shortcode: e.shortcode, url: e.url }));
  const authorEmojis = (account.emojis || [])
    .filter((e) => e.shortcode && e.url)
    .map((e) => ({ shortcode: e.shortcode, url: e.url }));

  const item = {
    uid: status.url || status.uri || "",
    url: status.url || status.uri || "",
    type: "note",
    name: "",
    content: {
      text: (status.content || "").replace(/<[^>]*>/g, ""),
      html: sanitizeContent(status.content || ""),
    },
    summary: status.spoiler_text || "",
    sensitive: status.sensitive || false,
    published: status.created_at || new Date().toISOString(),
    author: {
      name: sanitizeHtml(account.display_name || account.username || "Unknown", { allowedTags: [], allowedAttributes: {} }),
      url: account.url || "",
      photo: account.avatar || account.avatar_static || "",
      handle,
      emojis: authorEmojis,
    },
    category,
    mentions,
    emojis,
    photo,
    video,
    audio,
    inReplyTo: status.in_reply_to_id ? `https://${instance}/web/statuses/${status.in_reply_to_id}` : "",
    createdAt: new Date().toISOString(),
    _explore: true,
  };

  // Map quoted post data if present (Mastodon 4.3+ quote support)
  // Mastodon API wraps the quoted status: { state: "accepted", quoted_status: { ...fullStatus } }
  const quotedStatus = status.quote?.quoted_status || null;
  if (quotedStatus) {
    item.quoteUrl = quotedStatus.url || quotedStatus.uri || "";

    const q = quotedStatus;
    const qAccount = q.account || {};
    const qAcct = qAccount.acct || "";
    const qHandle = qAcct.includes("@") ? `@${qAcct}` : `@${qAcct}@${instance}`;
    const qPhoto = [];
    for (const att of q.media_attachments || []) {
      const attUrl = att.url || att.remote_url || "";
      if (attUrl && (att.type === "image" || att.type === "gifv")) {
        qPhoto.push({
          url: attUrl,
          alt: att.description || "",
          width: att.meta?.original?.width || null,
          height: att.meta?.original?.height || null,
        });
      }
    }

    item.quote = {
      url: q.url || q.uri || "",
      uid: q.uri || q.url || "",
      author: {
        name: sanitizeHtml(qAccount.display_name || qAccount.username || "Unknown", { allowedTags: [], allowedAttributes: {} }),
        url: qAccount.url || "",
        photo: qAccount.avatar || qAccount.avatar_static || "",
        handle: qHandle,
      },
      content: {
        text: (q.content || "").replace(/<[^>]*>/g, ""),
        html: sanitizeContent(q.content || ""),
      },
      published: q.created_at || "",
      name: "",
      photo: qPhoto.slice(0, 1),
    };
  } else {
    item.quoteUrl = "";
  }

  return item;
}
