/**
 * Convert Indiekit JF2 post properties to ActivityStreams 2.0 objects.
 *
 * Two export flavors:
 * - jf2ToActivityStreams() — returns plain JSON-LD objects (for content negotiation)
 * - jf2ToAS2Activity()    — returns Fedify vocab instances (for outbox + syndicator)
 */

import { Temporal } from "@js-temporal/polyfill";
import {
  Announce,
  Article,
  Audio,
  Create,
  Hashtag,
  Image,
  Like,
  Note,
  Video,
} from "@fedify/fedify";

// ---------------------------------------------------------------------------
// Plain JSON-LD (content negotiation on individual post URLs)
// ---------------------------------------------------------------------------

/**
 * Convert JF2 properties to a plain ActivityStreams JSON-LD object.
 *
 * @param {object} properties - JF2 post properties
 * @param {string} actorUrl - Actor URL (e.g. "https://example.com/activitypub/users/rick")
 * @param {string} publicationUrl - Publication base URL with trailing slash
 * @returns {object} ActivityStreams activity (Create, Like, or Announce)
 */
export function jf2ToActivityStreams(properties, actorUrl, publicationUrl) {
  const postType = properties["post-type"];

  if (postType === "like") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Like",
      actor: actorUrl,
      object: properties["like-of"],
    };
  }

  if (postType === "repost") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Announce",
      actor: actorUrl,
      object: properties["repost-of"],
    };
  }

  const isArticle = postType === "article" && properties.name;
  const postUrl = resolvePostUrl(properties.url, publicationUrl);

  const object = {
    type: isArticle ? "Article" : "Note",
    id: postUrl,
    attributedTo: actorUrl,
    published: properties.published,
    url: postUrl,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${actorUrl.replace(/\/$/, "")}/followers`],
  };

  if (postType === "bookmark") {
    const bookmarkUrl = properties["bookmark-of"];
    const commentary = properties.content?.html || properties.content || "";
    object.content = commentary
      ? `${commentary}<br><br>\u{1F516} <a href="${bookmarkUrl}">${bookmarkUrl}</a>`
      : `\u{1F516} <a href="${bookmarkUrl}">${bookmarkUrl}</a>`;
    object.tag = [
      {
        type: "Hashtag",
        name: "#bookmark",
        href: `${publicationUrl}categories/bookmark`,
      },
    ];
  } else {
    object.content = properties.content?.html || properties.content || "";
  }

  // Append permalink to content so fediverse clients show a clickable link
  if (postUrl && object.content) {
    object.content += `<p>\u{1F517} <a href="${postUrl}">${postUrl}</a></p>`;
  }

  if (isArticle) {
    object.name = properties.name;
    if (properties.summary) {
      object.summary = properties.summary;
    }
  }

  if (properties["in-reply-to"]) {
    object.inReplyTo = properties["in-reply-to"];
  }

  const attachments = buildPlainAttachments(properties, publicationUrl);
  if (attachments.length > 0) {
    object.attachment = attachments;
  }

  const tags = buildPlainTags(properties, publicationUrl, object.tag);
  if (tags.length > 0) {
    object.tag = tags;
  }

  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    actor: actorUrl,
    object,
  };
}

// ---------------------------------------------------------------------------
// Fedify vocab objects (outbox dispatcher + syndicator delivery)
// ---------------------------------------------------------------------------

/**
 * Convert JF2 properties to a Fedify Activity object.
 *
 * @param {object} properties - JF2 post properties
 * @param {string} actorUrl - Actor URL (e.g. "https://example.com/activitypub/users/rick")
 * @param {string} publicationUrl - Publication base URL with trailing slash
 * @returns {import("@fedify/fedify").Activity | null}
 */
export function jf2ToAS2Activity(properties, actorUrl, publicationUrl) {
  const postType = properties["post-type"];
  const actorUri = new URL(actorUrl);

  if (postType === "like") {
    const likeOf = properties["like-of"];
    if (!likeOf) return null;
    return new Like({
      actor: actorUri,
      object: new URL(likeOf),
    });
  }

  if (postType === "repost") {
    const repostOf = properties["repost-of"];
    if (!repostOf) return null;
    return new Announce({
      actor: actorUri,
      object: new URL(repostOf),
      to: new URL("https://www.w3.org/ns/activitystreams#Public"),
    });
  }

  const isArticle = postType === "article" && properties.name;
  const postUrl = resolvePostUrl(properties.url, publicationUrl);
  const followersUrl = `${actorUrl.replace(/\/$/, "")}/followers`;

  const noteOptions = {
    attributedTo: actorUri,
    to: new URL("https://www.w3.org/ns/activitystreams#Public"),
    cc: new URL(followersUrl),
  };

  if (postUrl) {
    noteOptions.id = new URL(postUrl);
    noteOptions.url = new URL(postUrl);
  }

  if (properties.published) {
    try {
      noteOptions.published = Temporal.Instant.from(properties.published);
    } catch {
      // Invalid date format — skip
    }
  }

  // Content
  if (postType === "bookmark") {
    const bookmarkUrl = properties["bookmark-of"];
    const commentary = properties.content?.html || properties.content || "";
    noteOptions.content = commentary
      ? `${commentary}<br><br>\u{1F516} <a href="${bookmarkUrl}">${bookmarkUrl}</a>`
      : `\u{1F516} <a href="${bookmarkUrl}">${bookmarkUrl}</a>`;
  } else {
    noteOptions.content = properties.content?.html || properties.content || "";
  }

  // Append permalink to content so fediverse clients show a clickable link
  // back to the canonical post on the author's site
  if (postUrl && noteOptions.content) {
    noteOptions.content += `<p>\u{1F517} <a href="${postUrl}">${postUrl}</a></p>`;
  }

  if (isArticle) {
    noteOptions.name = properties.name;
    if (properties.summary) {
      noteOptions.summary = properties.summary;
    }
  }

  if (properties["in-reply-to"]) {
    noteOptions.inReplyTo = new URL(properties["in-reply-to"]);
  }

  // Attachments
  const fedifyAttachments = buildFedifyAttachments(properties, publicationUrl);
  if (fedifyAttachments.length > 0) {
    noteOptions.attachments = fedifyAttachments;
  }

  // Hashtags
  const fedifyTags = buildFedifyTags(properties, publicationUrl, postType);
  if (fedifyTags.length > 0) {
    noteOptions.tags = fedifyTags;
  }

  const object = isArticle
    ? new Article(noteOptions)
    : new Note(noteOptions);

  return new Create({
    actor: actorUri,
    object,
  });
}

// ---------------------------------------------------------------------------
// URL resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a post URL, ensuring it's absolute.
 * @param {string} url - Post URL (may be relative or absolute)
 * @param {string} publicationUrl - Base publication URL
 * @returns {string} Absolute URL
 */
export function resolvePostUrl(url, publicationUrl) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  const base = publicationUrl.replace(/\/$/, "");
  return `${base}/${url.replace(/^\//, "")}`;
}

function resolveMediaUrl(url, publicationUrl) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  const base = publicationUrl.replace(/\/$/, "");
  return `${base}/${url.replace(/^\//, "")}`;
}

// ---------------------------------------------------------------------------
// Attachment builders
// ---------------------------------------------------------------------------

function buildPlainAttachments(properties, publicationUrl) {
  const attachments = [];

  if (properties.photo) {
    for (const photo of asArray(properties.photo)) {
      const url = typeof photo === "string" ? photo : photo.url;
      const alt = typeof photo === "string" ? "" : photo.alt || "";
      attachments.push({
        type: "Image",
        mediaType: guessMediaType(url),
        url: resolveMediaUrl(url, publicationUrl),
        name: alt,
      });
    }
  }

  if (properties.video) {
    for (const video of asArray(properties.video)) {
      const url = typeof video === "string" ? video : video.url;
      attachments.push({
        type: "Video",
        url: resolveMediaUrl(url, publicationUrl),
        name: "",
      });
    }
  }

  if (properties.audio) {
    for (const audio of asArray(properties.audio)) {
      const url = typeof audio === "string" ? audio : audio.url;
      attachments.push({
        type: "Audio",
        url: resolveMediaUrl(url, publicationUrl),
        name: "",
      });
    }
  }

  return attachments;
}

function buildFedifyAttachments(properties, publicationUrl) {
  const attachments = [];

  if (properties.photo) {
    for (const photo of asArray(properties.photo)) {
      const url = typeof photo === "string" ? photo : photo.url;
      const alt = typeof photo === "string" ? "" : photo.alt || "";
      attachments.push(
        new Image({
          url: new URL(resolveMediaUrl(url, publicationUrl)),
          mediaType: guessMediaType(url),
          name: alt,
        }),
      );
    }
  }

  if (properties.video) {
    for (const video of asArray(properties.video)) {
      const url = typeof video === "string" ? video : video.url;
      attachments.push(
        new Video({
          url: new URL(resolveMediaUrl(url, publicationUrl)),
        }),
      );
    }
  }

  if (properties.audio) {
    for (const audio of asArray(properties.audio)) {
      const url = typeof audio === "string" ? audio : audio.url;
      attachments.push(
        new Audio({
          url: new URL(resolveMediaUrl(url, publicationUrl)),
        }),
      );
    }
  }

  return attachments;
}

// ---------------------------------------------------------------------------
// Tag builders
// ---------------------------------------------------------------------------

function buildPlainTags(properties, publicationUrl, existing) {
  const tags = [...(existing || [])];
  if (properties.category) {
    for (const cat of asArray(properties.category)) {
      tags.push({
        type: "Hashtag",
        name: `#${cat.replace(/\s+/g, "")}`,
        href: `${publicationUrl}categories/${encodeURIComponent(cat)}`,
      });
    }
  }
  return tags;
}

function buildFedifyTags(properties, publicationUrl, postType) {
  const tags = [];
  if (postType === "bookmark") {
    tags.push(
      new Hashtag({
        name: "#bookmark",
        href: new URL(`${publicationUrl}categories/bookmark`),
      }),
    );
  }
  if (properties.category) {
    for (const cat of asArray(properties.category)) {
      tags.push(
        new Hashtag({
          name: `#${cat.replace(/\s+/g, "")}`,
          href: new URL(
            `${publicationUrl}categories/${encodeURIComponent(cat)}`,
          ),
        }),
      );
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function guessMediaType(url) {
  const ext = url.split(".").pop()?.toLowerCase();
  const types = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return types[ext] || "image/jpeg";
}
