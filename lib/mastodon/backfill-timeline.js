/**
 * Backfill ap_timeline from the posts collection.
 *
 * Runs on startup (idempotent — uses upsert by uid).
 * Converts Micropub JF2 posts into ap_timeline format so they
 * appear in Mastodon Client API timelines and profile views.
 */

/**
 * Backfill ap_timeline with published posts from the posts collection.
 *
 * @param {object} collections - MongoDB collections (must include posts, ap_timeline, ap_profile)
 * @returns {Promise<{ total: number, inserted: number, skipped: number }>}
 */
export async function backfillTimeline(collections) {
  const { posts, ap_timeline, ap_profile } = collections;

  if (!posts || !ap_timeline) {
    return { total: 0, inserted: 0, skipped: 0 };
  }

  // Get local profile for author info
  const profile = await ap_profile?.findOne({});
  const siteUrl = profile?.url?.replace(/\/$/, "") || "";
  const author = profile
    ? {
        name: profile.name || "",
        url: profile.url || "",
        photo: profile.icon || "",
        handle: "",
      }
    : { name: "", url: "", photo: "", handle: "" };

  // Fetch all published posts
  const allPosts = await posts
    .find({
      "properties.post-status": { $ne: "draft" },
      "properties.deleted": { $exists: false },
      "properties.url": { $exists: true },
    })
    .toArray();

  let inserted = 0;
  let skipped = 0;

  for (const post of allPosts) {
    const props = post.properties;
    if (!props?.url) {
      skipped++;
      continue;
    }

    const uid = props.url;

    // Check if already in timeline (fast path to avoid unnecessary upserts)
    const exists = await ap_timeline.findOne({ uid }, { projection: { _id: 1 } });
    if (exists) {
      skipped++;
      continue;
    }

    // Build content — interaction types (bookmark, like, repost) may not have
    // body content, so synthesize it from the interaction target URL
    const content = buildContent(props);
    const type = mapPostType(props["post-type"]);

    // Extract categories + inline hashtags from content
    const categories = normalizeArray(props.category);
    const inlineHashtags = extractHashtags(content.text + " " + (content.html || ""));
    const mergedCategories = mergeCategories(categories, inlineHashtags);

    const timelineItem = {
      uid,
      url: uid,
      type,
      content: rewriteHashtagLinks(content, siteUrl),
      author,
      published: props.published || props.date || new Date().toISOString(),
      createdAt: props.published || props.date || new Date().toISOString(),
      visibility: "public",
      sensitive: false,
      category: mergedCategories,
      photo: normalizeMediaArray(props.photo, siteUrl),
      video: normalizeMediaArray(props.video, siteUrl),
      audio: normalizeMediaArray(props.audio, siteUrl),
      readBy: [],
    };

    // Optional fields
    if (props.name) timelineItem.name = props.name;
    if (props.summary) timelineItem.summary = props.summary;
    if (props["in-reply-to"]) {
      timelineItem.inReplyTo = Array.isArray(props["in-reply-to"])
        ? props["in-reply-to"][0]
        : props["in-reply-to"];
    }

    try {
      const result = await ap_timeline.updateOne(
        { uid },
        { $setOnInsert: timelineItem },
        { upsert: true },
      );
      if (result.upsertedCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  return { total: allPosts.length, inserted, skipped };
}

// ─── Content Building ─────────────────────────────────────────────────────────

/**
 * Build content from JF2 properties, synthesizing content for interaction types.
 * Bookmarks, likes, and reposts often have no body text — show the target URL.
 */
function buildContent(props) {
  const raw = normalizeContent(props.content);

  // If there's already content, use it
  if (raw.text || raw.html) return raw;

  // Synthesize content for interaction types
  const bookmarkOf = props["bookmark-of"];
  const likeOf = props["like-of"];
  const repostOf = props["repost-of"];
  const name = props.name;

  if (bookmarkOf) {
    const label = name || bookmarkOf;
    return {
      text: `Bookmarked: ${label}`,
      html: `<p>Bookmarked: <a href="${escapeHtml(bookmarkOf)}">${escapeHtml(label)}</a></p>`,
    };
  }

  if (likeOf) {
    return {
      text: `Liked: ${likeOf}`,
      html: `<p>Liked: <a href="${escapeHtml(likeOf)}">${escapeHtml(likeOf)}</a></p>`,
    };
  }

  if (repostOf) {
    const label = name || repostOf;
    return {
      text: `Reposted: ${label}`,
      html: `<p>Reposted: <a href="${escapeHtml(repostOf)}">${escapeHtml(label)}</a></p>`,
    };
  }

  // Article with title but no body
  if (name) {
    return { text: name, html: `<p>${escapeHtml(name)}</p>` };
  }

  return raw;
}

/**
 * Normalize content from JF2 properties to { text, html } format.
 */
function normalizeContent(content) {
  if (!content) return { text: "", html: "" };
  if (typeof content === "string") return { text: content, html: `<p>${content}</p>` };
  if (typeof content === "object") {
    return {
      text: content.text || content.value || "",
      html: content.html || content.text || content.value || "",
    };
  }
  return { text: "", html: "" };
}

// ─── Hashtag Handling ─────────────────────────────────────────────────────────

/**
 * Extract hashtags from text content.
 * Matches #word patterns, returns lowercase tag names without the # prefix.
 */
function extractHashtags(text) {
  if (!text) return [];
  const matches = text.match(/(?:^|\s)#([a-zA-Z_]\w*)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.trim().slice(1).toLowerCase()))];
}

/**
 * Merge explicit categories with inline hashtags (deduplicated, case-insensitive).
 */
function mergeCategories(categories, hashtags) {
  const seen = new Set(categories.map((c) => c.toLowerCase()));
  const result = [...categories];
  for (const tag of hashtags) {
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

/**
 * Rewrite hashtag links in HTML from site-internal (/categories/tag/) to
 * Mastodon-compatible format. Mastodon clients use the tag objects, not
 * inline links, but having correct href helps with link following.
 */
function rewriteHashtagLinks(content, siteUrl) {
  if (!content.html) return content;
  // Rewrite /categories/tag/ links to /tags/tag (Mastodon convention)
  let html = content.html.replace(
    /href="\/categories\/([^/"]+)\/?"/g,
    (_, tag) => `href="${siteUrl}/tags/${tag}" class="hashtag" rel="tag"`,
  );
  // Also rewrite absolute site category links
  if (siteUrl) {
    html = html.replace(
      new RegExp(`href="${escapeRegex(siteUrl)}/categories/([^/"]+)/?"`, "g"),
      (_, tag) => `href="${siteUrl}/tags/${tag}" class="hashtag" rel="tag"`,
    );
  }
  return { ...content, html };
}

// ─── Post Type Mapping ────────────────────────────────────────────────────────

/**
 * Map Micropub post-type to timeline type.
 */
function mapPostType(postType) {
  switch (postType) {
    case "article":
      return "article";
    case "photo":
    case "video":
    case "audio":
      return "note";
    case "reply":
      return "note";
    case "repost":
      return "boost";
    case "like":
    case "bookmark":
      return "note";
    default:
      return "note";
  }
}

// ─── Normalization Helpers ────────────────────────────────────────────────────

/**
 * Normalize a value to an array of strings.
 */
function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/**
 * Normalize media values — resolves relative URLs to absolute.
 *
 * @param {*} value - String, object with url, or array thereof
 * @param {string} siteUrl - Base site URL for resolving relative paths
 */
function normalizeMediaArray(value, siteUrl) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((item) => {
    if (typeof item === "string") return resolveUrl(item, siteUrl);
    if (typeof item === "object" && item.url) {
      return { ...item, url: resolveUrl(item.url, siteUrl) };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Resolve a URL — if relative, prepend the site URL.
 */
function resolveUrl(url, siteUrl) {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${siteUrl}${url}`;
  return `${siteUrl}/${url}`;
}

/**
 * Escape HTML entities.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape regex special characters.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
