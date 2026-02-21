/**
 * Timeline item extraction helpers
 * @module timeline-store
 */

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
 * @returns {object} { name, url, photo, handle }
 */
export async function extractActorInfo(actor) {
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
  let photo = "";
  try {
    if (typeof actor.getIcon === "function") {
      const iconObj = await actor.getIcon();
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
 * @returns {Promise<object>} Timeline item data
 */
export async function extractObjectData(object, options = {}) {
  if (!object) {
    throw new Error("Object is required");
  }

  const uid = object.id?.href || "";
  const url = object.url?.href || uid;

  // Determine type
  let type = "note";
  if (object.type?.toLowerCase() === "article") {
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
    ? new Date(object.published).toISOString()
    : new Date().toISOString();

  // Extract author — use async getAttributedTo() for Fedify objects
  let authorObj = null;
  try {
    if (typeof object.getAttributedTo === "function") {
      const attr = await object.getAttributedTo();
      authorObj = Array.isArray(attr) ? attr[0] : attr;
    }
  } catch {
    // Fallback: try direct property access for plain objects
    authorObj = object.attribution || object.attributedTo || null;
  }
  const author = await extractActorInfo(authorObj);

  // Extract tags/categories
  const category = [];
  if (object.tag) {
    const tags = Array.isArray(object.tag) ? object.tag : [object.tag];
    for (const tag of tags) {
      if (tag.type === "Hashtag" && tag.name) {
        category.push(tag.name.toString().replace(/^#/, ""));
      }
    }
  }

  // Extract media attachments
  const photo = [];
  const video = [];
  const audio = [];

  if (object.attachment) {
    const attachments = Array.isArray(object.attachment) ? object.attachment : [object.attachment];
    for (const att of attachments) {
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

  // In-reply-to
  const inReplyTo = object.inReplyTo?.href || "";

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
