/**
 * Convert Indiekit JF2 post properties to ActivityStreams 2.0 objects.
 *
 * JF2 is the simplified Microformats2 JSON format used by Indiekit internally.
 * ActivityStreams 2.0 (AS2) is the JSON-LD format used by ActivityPub for federation.
 *
 * @param {object} properties - JF2 post properties from Indiekit's posts collection
 * @param {string} actorUrl - This actor's URL (e.g. "https://rmendes.net/")
 * @param {string} publicationUrl - Publication base URL with trailing slash
 * @returns {object} ActivityStreams activity (Create, Like, or Announce)
 */
export function jf2ToActivityStreams(properties, actorUrl, publicationUrl) {
  const postType = properties["post-type"];

  // Like — not wrapped in Create, stands alone
  if (postType === "like") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Like",
      actor: actorUrl,
      object: properties["like-of"],
    };
  }

  // Repost/boost — Announce activity
  if (postType === "repost") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Announce",
      actor: actorUrl,
      object: properties["repost-of"],
    };
  }

  // Everything else is wrapped in a Create activity
  const isArticle = postType === "article" && properties.name;
  const postUrl = resolvePostUrl(properties.url, publicationUrl);

  const object = {
    type: isArticle ? "Article" : "Note",
    id: postUrl,
    attributedTo: actorUrl,
    published: properties.published,
    url: postUrl,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${actorUrl.replace(/\/$/, "")}/activitypub/followers`],
  };

  // Content — bookmarks get special treatment
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

  if (isArticle) {
    object.name = properties.name;
    if (properties.summary) {
      object.summary = properties.summary;
    }
  }

  // Reply
  if (properties["in-reply-to"]) {
    object.inReplyTo = properties["in-reply-to"];
  }

  // Media attachments
  const attachments = [];

  if (properties.photo) {
    const photos = Array.isArray(properties.photo)
      ? properties.photo
      : [properties.photo];
    for (const photo of photos) {
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
    const videos = Array.isArray(properties.video)
      ? properties.video
      : [properties.video];
    for (const video of videos) {
      const url = typeof video === "string" ? video : video.url;
      attachments.push({
        type: "Video",
        url: resolveMediaUrl(url, publicationUrl),
        name: "",
      });
    }
  }

  if (properties.audio) {
    const audios = Array.isArray(properties.audio)
      ? properties.audio
      : [properties.audio];
    for (const audio of audios) {
      const url = typeof audio === "string" ? audio : audio.url;
      attachments.push({
        type: "Audio",
        url: resolveMediaUrl(url, publicationUrl),
        name: "",
      });
    }
  }

  if (attachments.length > 0) {
    object.attachment = attachments;
  }

  // Categories → hashtags
  if (properties.category) {
    const categories = Array.isArray(properties.category)
      ? properties.category
      : [properties.category];
    object.tag = [
      ...(object.tag || []),
      ...categories.map((cat) => ({
        type: "Hashtag",
        name: `#${cat.replace(/\s+/g, "")}`,
        href: `${publicationUrl}categories/${encodeURIComponent(cat)}`,
      })),
    ];
  }

  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    actor: actorUrl,
    object,
  };
}

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

/**
 * Resolve a media URL, ensuring it's absolute.
 */
function resolveMediaUrl(url, publicationUrl) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  const base = publicationUrl.replace(/\/$/, "");
  return `${base}/${url.replace(/^\//, "")}`;
}

/**
 * Guess MIME type from file extension.
 */
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
