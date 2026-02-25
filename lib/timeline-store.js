/**
 * Timeline item extraction helpers
 * @module timeline-store
 */

import { Article } from "@fedify/fedify/vocab";
import sanitizeHtml from "sanitize-html";

/**
 * Sanitize HTML content for safe display
 * @param {string} html - Raw HTML content
 * @returns {string} Sanitized HTML
 */
export function sanitizeContent(html) {
  if (!html) return "";

  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "a", "strong", "em", "ul", "ol", "li",
      "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
      "span", "div", "img"
    ],
    allowedAttributes: {
      a: ["href", "rel", "class"],
      img: ["src", "alt", "class"],
      span: ["class"],
      div: ["class"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https", "data"]
    }
  });
}

/**
 * Extract actor information from Fedify Person/Application/Service object
 * @param {object} actor - Fedify actor object
 * @param {object} [options] - Options
 * @param {object} [options.documentLoader] - Authenticated DocumentLoader for Secure Mode servers
 * @returns {object} { name, url, photo, handle }
 */
export async function extractActorInfo(actor, options = {}) {
  if (!actor) {
    return {
      name: "Unknown",
      url: "",
      photo: "",
      handle: ""
    };
  }

  const rawName = actor.name?.toString() || actor.preferredUsername?.toString() || "Unknown";
  // Strip all HTML from actor names to prevent stored XSS
  const name = sanitizeHtml(rawName, { allowedTags: [], allowedAttributes: {} });
  const url = actor.id?.href || "";

  // Extract photo URL from icon (Fedify uses async getters)
  const loaderOpts = options.documentLoader ? { documentLoader: options.documentLoader } : {};
  let photo = "";
  try {
    if (typeof actor.getIcon === "function") {
      const iconObj = await actor.getIcon(loaderOpts);
      photo = iconObj?.url?.href || "";
    } else {
      const iconObj = await actor.icon;
      photo = iconObj?.url?.href || "";
    }
  } catch {
    // No icon available
  }

  // Extract handle from actor URL
  let handle = "";
  try {
    const actorUrl = new URL(url);
    const username = actor.preferredUsername?.toString() || "";
    if (username) {
      handle = `@${username}@${actorUrl.hostname}`;
    }
  } catch {
    // Invalid URL, keep handle empty
  }

  return { name, url, photo, handle };
}

/**
 * Extract timeline item data from Fedify Note/Article object
 * @param {object} object - Fedify Note or Article object
 * @param {object} options - Extraction options
 * @param {object} [options.boostedBy] - Actor info for boosts
 * @param {Date} [options.boostedAt] - Boost timestamp
 * @param {object} [options.actorFallback] - Fedify actor to use when object.getAttributedTo() fails
 * @param {object} [options.documentLoader] - Authenticated DocumentLoader for Secure Mode servers
 * @returns {Promise<object>} Timeline item data
 */
export async function extractObjectData(object, options = {}) {
  if (!object) {
    throw new Error("Object is required");
  }

  const uid = object.id?.href || "";
  const url = object.url?.href || uid;

  // Determine type — use instanceof for Fedify vocab objects
  let type = "note";
  if (object instanceof Article) {
    type = "article";
  }
  if (options.boostedBy) {
    type = "boost";
  }

  // Extract content
  const contentHtml = object.content?.toString() || "";
  const contentText = object.source?.content?.toString() || contentHtml.replace(/<[^>]*>/g, "");

  const content = {
    text: contentText,
    html: sanitizeContent(contentHtml)
  };

  // Extract name (articles only)
  const name = type === "article" ? (object.name?.toString() || "") : "";

  // Content warning / summary
  const summary = object.summary?.toString() || "";
  const sensitive = object.sensitive || false;

  // Published date — store as ISO string per Indiekit convention
  const published = object.published
    ? String(object.published)
    : new Date().toISOString();

  // Extract author — try multiple strategies in order of reliability
  const loaderOpts = options.documentLoader ? { documentLoader: options.documentLoader } : {};
  let authorObj = null;
  try {
    if (typeof object.getAttributedTo === "function") {
      const attr = await object.getAttributedTo(loaderOpts);
      authorObj = Array.isArray(attr) ? attr[0] : attr;
    }
  } catch {
    // getAttributedTo() failed (unreachable, deleted, etc.)
  }
  // If getAttributedTo() returned nothing, use the actor from the wrapping activity
  if (!authorObj && options.actorFallback) {
    authorObj = options.actorFallback;
  }
  // Try direct property access for plain objects
  if (!authorObj) {
    authorObj = object.attribution || object.attributedTo || null;
  }

  let author;
  if (authorObj) {
    author = await extractActorInfo(authorObj, loaderOpts);
  } else {
    // Last resort: use attributionIds (non-fetching) to get at least a URL
    const attrIds = object.attributionIds;
    if (attrIds && attrIds.length > 0) {
      const authorUrl = attrIds[0].href;
      const parsedUrl = new URL(authorUrl);
      const authorHostname = parsedUrl.hostname;
      // Extract username from common URL patterns:
      //   /@username, /users/username, /ap/users/12345/
      const pathname = parsedUrl.pathname;
      let username = "";
      const atPattern = pathname.match(/\/@([^/]+)/);
      const usersPattern = pathname.match(/\/users\/([^/]+)/);
      if (atPattern) {
        username = atPattern[1];
      } else if (usersPattern) {
        username = usersPattern[1];
      }
      author = {
        name: username || authorHostname,
        url: authorUrl,
        photo: "",
        handle: username ? `@${username}@${authorHostname}` : "",
      };
    } else {
      author = { name: "Unknown", url: "", photo: "", handle: "" };
    }
  }

  // Extract tags/categories — Fedify uses async getTags()
  const category = [];
  try {
    if (typeof object.getTags === "function") {
      const tags = await object.getTags(loaderOpts);
      for await (const tag of tags) {
        if (tag.name) {
          const tagName = tag.name.toString().replace(/^#/, "");
          if (tagName) category.push(tagName);
        }
      }
    }
  } catch {
    // Tags extraction failed — non-critical
  }

  // Extract media attachments — Fedify uses async getAttachments()
  const photo = [];
  const video = [];
  const audio = [];

  try {
    if (typeof object.getAttachments === "function") {
      const attachments = await object.getAttachments(loaderOpts);
      for await (const att of attachments) {
        const mediaUrl = att.url?.href || "";
        if (!mediaUrl) continue;

        const mediaType = att.mediaType?.toLowerCase() || "";

        if (mediaType.startsWith("image/")) {
          photo.push(mediaUrl);
        } else if (mediaType.startsWith("video/")) {
          video.push(mediaUrl);
        } else if (mediaType.startsWith("audio/")) {
          audio.push(mediaUrl);
        }
      }
    }
  } catch {
    // Attachment extraction failed — non-critical
  }

  // In-reply-to — Fedify uses replyTargetId (non-fetching)
  const inReplyTo = object.replyTargetId?.href || "";

  // Build base timeline item
  const item = {
    uid,
    type,
    url,
    name,
    content,
    summary,
    sensitive,
    published,
    author,
    category,
    photo,
    video,
    audio,
    inReplyTo,
    createdAt: new Date().toISOString()
  };

  // Add boost metadata if this is a boost
  if (options.boostedBy) {
    item.boostedBy = options.boostedBy;
    item.boostedAt = options.boostedAt || new Date().toISOString();
    item.originalUrl = url;
  }

  return item;
}
