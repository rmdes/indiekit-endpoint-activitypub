/**
 * Status endpoints for Mastodon Client API.
 *
 * GET /api/v1/statuses/:id — single status
 * GET /api/v1/statuses/:id/context — thread context (ancestors + descendants)
 * POST /api/v1/statuses — create post via Micropub pipeline
 * DELETE /api/v1/statuses/:id — delete post via Micropub pipeline
 * POST /api/v1/statuses/:id/favourite — like a post
 * POST /api/v1/statuses/:id/unfavourite — unlike a post
 * POST /api/v1/statuses/:id/reblog — boost a post
 * POST /api/v1/statuses/:id/unreblog — unboost a post
 * POST /api/v1/statuses/:id/bookmark — bookmark a post
 * POST /api/v1/statuses/:id/unbookmark — remove bookmark
 */
import express from "express";
import { ObjectId } from "mongodb";
import { serializeStatus } from "../entities/status.js";
import { decodeCursor } from "../helpers/pagination.js";
import {
  likePost, unlikePost,
  boostPost, unboostPost,
  bookmarkPost, unbookmarkPost,
} from "../helpers/interactions.js";
import { addTimelineItem } from "../../storage/timeline.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/statuses/:id ───────────────────────────────────────────────

router.get("/api/v1/statuses/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Load interaction state if authenticated
    const interactionState = await loadItemInteractions(collections, item);

    const status = serializeStatus(item, {
      baseUrl,
      ...interactionState,
      pinnedIds: new Set(),
    });

    res.json(status);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/context ───────────────────────────────────────

router.get("/api/v1/statuses/:id/context", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Find ancestors: walk up the inReplyTo chain
    const ancestors = [];
    let currentReplyTo = item.inReplyTo;
    const visited = new Set();

    while (currentReplyTo && ancestors.length < 40) {
      if (visited.has(currentReplyTo)) break;
      visited.add(currentReplyTo);

      const parent = await collections.ap_timeline.findOne({
        $or: [{ uid: currentReplyTo }, { url: currentReplyTo }],
      });
      if (!parent) break;

      ancestors.unshift(parent);
      currentReplyTo = parent.inReplyTo;
    }

    // Find descendants: items that reply to this post's uid or url
    const targetUrls = [item.uid, item.url].filter(Boolean);
    let descendants = [];

    if (targetUrls.length > 0) {
      // Get direct replies first
      const directReplies = await collections.ap_timeline
        .find({ inReplyTo: { $in: targetUrls } })
        .sort({ _id: 1 })
        .limit(60)
        .toArray();

      descendants = directReplies;

      // Also fetch replies to direct replies (2 levels deep)
      if (directReplies.length > 0) {
        const replyUrls = directReplies
          .flatMap((r) => [r.uid, r.url].filter(Boolean));
        const nestedReplies = await collections.ap_timeline
          .find({ inReplyTo: { $in: replyUrls } })
          .sort({ _id: 1 })
          .limit(60)
          .toArray();
        descendants.push(...nestedReplies);
      }
    }

    // Serialize all items
    const emptyInteractions = {
      favouritedIds: new Set(),
      rebloggedIds: new Set(),
      bookmarkedIds: new Set(),
      pinnedIds: new Set(),
    };

    const serializeOpts = { baseUrl, ...emptyInteractions };

    res.json({
      ancestors: ancestors.map((a) => serializeStatus(a, serializeOpts)),
      descendants: descendants.map((d) => serializeStatus(d, serializeOpts)),
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses ───────────────────────────────────────────────────
// Creates a post via the Micropub pipeline so it goes through the full flow:
// Micropub → content file → Eleventy build → syndication → AP federation.

router.post("/api/v1/statuses", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { application, publication } = req.app.locals;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const {
      status: statusText,
      spoiler_text: spoilerText,
      visibility = "public",
      sensitive = false,
      language,
      in_reply_to_id: inReplyToId,
      media_ids: mediaIds,
    } = req.body;

    if (!statusText && (!mediaIds || mediaIds.length === 0)) {
      return res.status(422).json({ error: "Validation failed: Text content is required" });
    }

    // Resolve in_reply_to URL from status ID (cursor or ObjectId)
    let inReplyTo = null;
    if (inReplyToId) {
      const replyItem = await findTimelineItemById(collections.ap_timeline, inReplyToId);
      if (replyItem) {
        inReplyTo = replyItem.uid || replyItem.url;
      }
    }

    // Build JF2 properties for the Micropub pipeline
    const jf2 = {
      type: "entry",
      content: statusText || "",
    };

    if (inReplyTo) {
      jf2["in-reply-to"] = inReplyTo;
    }

    if (spoilerText) {
      jf2.summary = spoilerText;
    }

    if (sensitive === true || sensitive === "true") {
      jf2.sensitive = "true";
    }

    if (visibility && visibility !== "public") {
      jf2.visibility = visibility;
    }

    if (language) {
      jf2["mp-language"] = language;
    }

    // Syndicate to AP only — posts from Mastodon clients belong to the fediverse.
    // Never cross-post to Bluesky (conversations stay in their protocol).
    // The publication URL is the AP syndicator's uid.
    const publicationUrl = pluginOptions.publicationUrl || baseUrl;
    jf2["mp-syndicate-to"] = [publicationUrl.replace(/\/$/, "") + "/"];

    // Create post via Micropub pipeline (same functions the Micropub endpoint uses)
    // postData.create() handles: normalization, post type detection, path rendering,
    // mp-syndicate-to validated against configured syndicators, MongoDB posts collection
    const { postData } = await import("@indiekit/endpoint-micropub/lib/post-data.js");
    const { postContent } = await import("@indiekit/endpoint-micropub/lib/post-content.js");

    const data = await postData.create(application, publication, jf2);
    // postContent.create() handles: template rendering, file creation in store
    await postContent.create(publication, data);

    const postUrl = data.properties.url;
    console.info(`[Mastodon API] Created post via Micropub: ${postUrl}`);

    // Add to ap_timeline so the post is visible in the Mastodon Client API
    const profile = await collections.ap_profile.findOne({});
    const handle = pluginOptions.handle || "user";
    const actorUrl = profile?.url || `${publicationUrl}/users/${handle}`;

    // Extract hashtags from status text and merge with any Micropub categories
    const categories = data.properties.category || [];
    const inlineHashtags = (statusText || "").match(/(?:^|\s)#([a-zA-Z_]\w*)/g);
    if (inlineHashtags) {
      const existing = new Set(categories.map((c) => c.toLowerCase()));
      for (const match of inlineHashtags) {
        const tag = match.trim().slice(1).toLowerCase();
        if (!existing.has(tag)) {
          existing.add(tag);
          categories.push(tag);
        }
      }
    }

    // Resolve relative media URLs to absolute
    const resolveMedia = (items) => {
      if (!items || !items.length) return [];
      return items.map((item) => {
        if (typeof item === "string") {
          return item.startsWith("http") ? item : `${publicationUrl.replace(/\/$/, "")}/${item.replace(/^\//, "")}`;
        }
        if (item?.url && !item.url.startsWith("http")) {
          return { ...item, url: `${publicationUrl.replace(/\/$/, "")}/${item.url.replace(/^\//, "")}` };
        }
        return item;
      });
    };

    // Process content: linkify URLs and extract @mentions
    const rawContent = data.properties.content || { text: statusText || "", html: "" };
    const processedContent = processStatusContent(rawContent, statusText || "");
    const mentions = extractMentions(statusText || "");

    const now = new Date().toISOString();
    const timelineItem = await addTimelineItem(collections, {
      uid: postUrl,
      url: postUrl,
      type: data.properties["post-type"] || "note",
      content: processedContent,
      summary: spoilerText || "",
      sensitive: sensitive === true || sensitive === "true",
      visibility: visibility || "public",
      language: language || null,
      inReplyTo,
      published: data.properties.published || now,
      createdAt: now,
      author: {
        name: profile?.name || handle,
        url: profile?.url || publicationUrl,
        photo: profile?.icon || "",
        handle: `@${handle}`,
        emojis: [],
        bot: false,
      },
      photo: resolveMedia(data.properties.photo || []),
      video: resolveMedia(data.properties.video || []),
      audio: resolveMedia(data.properties.audio || []),
      category: categories,
      counts: { replies: 0, boosts: 0, likes: 0 },
      linkPreviews: [],
      mentions,
      emojis: [],
    });

    // Serialize and return
    const serialized = serializeStatus(timelineItem, {
      baseUrl,
      favouritedIds: new Set(),
      rebloggedIds: new Set(),
      bookmarkedIds: new Set(),
      pinnedIds: new Set(),
    });

    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/statuses/:id ────────────────────────────────────────────
// Deletes via Micropub pipeline (removes content file + MongoDB post) and
// cleans up the ap_timeline entry.

router.delete("/api/v1/statuses/:id", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { application, publication } = req.app.locals;
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Verify ownership — only allow deleting own posts
    const profile = await collections.ap_profile.findOne({});
    if (profile && item.author?.url !== profile.url) {
      return res.status(403).json({ error: "This action is not allowed" });
    }

    // Serialize before deleting (Mastodon returns the deleted status with text source)
    const serialized = serializeStatus(item, {
      baseUrl,
      favouritedIds: new Set(),
      rebloggedIds: new Set(),
      bookmarkedIds: new Set(),
      pinnedIds: new Set(),
    });
    serialized.text = item.content?.text || "";

    // Delete via Micropub pipeline (removes content file from store + MongoDB posts)
    const postUrl = item.uid || item.url;
    try {
      const { postData } = await import("@indiekit/endpoint-micropub/lib/post-data.js");
      const { postContent } = await import("@indiekit/endpoint-micropub/lib/post-content.js");

      const existingPost = await postData.read(application, postUrl);
      if (existingPost) {
        const deletedData = await postData.delete(application, postUrl);
        await postContent.delete(publication, deletedData);
        console.info(`[Mastodon API] Deleted post via Micropub: ${postUrl}`);
      }
    } catch (err) {
      // Log but don't block — the post may not exist in Micropub (e.g. old pre-pipeline posts)
      console.warn(`[Mastodon API] Micropub delete failed for ${postUrl}: ${err.message}`);
    }

    // Delete from timeline
    await collections.ap_timeline.deleteOne({ _id: objectId });

    // Clean up interactions
    if (collections.ap_interactions && item.uid) {
      await collections.ap_interactions.deleteMany({ objectUrl: item.uid });
    }

    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/favourited_by ─────────────────────────────────

router.get("/api/v1/statuses/:id/favourited_by", async (req, res) => {
  // Stub — we don't track who favourited remotely
  res.json([]);
});

// ─── GET /api/v1/statuses/:id/reblogged_by ──────────────────────────────────

router.get("/api/v1/statuses/:id/reblogged_by", async (req, res) => {
  // Stub — we don't track who boosted remotely
  res.json([]);
});

// ─── POST /api/v1/statuses/:id/favourite ────────────────────────────────────

router.post("/api/v1/statuses/:id/favourite", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await likePost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    // Force favourited=true since we just liked it
    interactionState.favouritedIds.add(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unfavourite ──────────────────────────────────

router.post("/api/v1/statuses/:id/unfavourite", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await unlikePost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.favouritedIds.delete(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/reblog ───────────────────────────────────────

router.post("/api/v1/statuses/:id/reblog", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await boostPost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.rebloggedIds.add(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unreblog ─────────────────────────────────────

router.post("/api/v1/statuses/:id/unreblog", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const opts = getFederationOpts(req);
    await unboostPost({
      targetUrl: item.uid || item.url,
      ...opts,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.rebloggedIds.delete(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/bookmark ─────────────────────────────────────

router.post("/api/v1/statuses/:id/bookmark", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    await bookmarkPost({
      targetUrl: item.uid || item.url,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.bookmarkedIds.add(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/unbookmark ───────────────────────────────────

router.post("/api/v1/statuses/:id/unbookmark", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { item, collections, baseUrl } = await resolveStatusForInteraction(req);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    await unbookmarkPost({
      targetUrl: item.uid || item.url,
      interactions: collections.ap_interactions,
    });

    const interactionState = await loadItemInteractions(collections, item);
    interactionState.bookmarkedIds.delete(item.uid);

    res.json(serializeStatus(item, { baseUrl, ...interactionState, pinnedIds: new Set() }));
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a timeline item by cursor ID (published-based) or ObjectId (legacy).
 * Status IDs are now encodeCursor(published) — milliseconds since epoch.
 * Falls back to ObjectId lookup for backwards compatibility.
 *
 * @param {object} collection - ap_timeline collection
 * @param {string} id - Status ID from client
 * @returns {Promise<object|null>} Timeline document or null
 */
async function findTimelineItemById(collection, id) {
  // Try cursor-based lookup first (published date from ms-since-epoch)
  const publishedDate = decodeCursor(id);
  if (publishedDate) {
    // Try exact match first (with .000Z suffix from toISOString)
    let item = await collection.findOne({ published: publishedDate });
    if (item) return item;

    // Try without milliseconds — stored dates often lack .000Z
    // e.g., "2026-03-21T15:33:50Z" vs "2026-03-21T15:33:50.000Z"
    const withoutMs = publishedDate.replace(/\.000Z$/, "Z");
    if (withoutMs !== publishedDate) {
      item = await collection.findOne({ published: withoutMs });
      if (item) return item;
    }
  }

  // Fall back to ObjectId lookup (legacy IDs)
  try {
    return await collection.findOne({ _id: new ObjectId(id) });
  } catch {
    return null;
  }
}

/**
 * Resolve a timeline item from the :id param, plus common context.
 */
async function resolveStatusForInteraction(req) {
  const collections = req.app.locals.mastodonCollections;
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const item = await findTimelineItemById(collections.ap_timeline, req.params.id);
  return { item, collections, baseUrl };
}

/**
 * Build federation options from request context for interaction helpers.
 */
function getFederationOpts(req) {
  const pluginOptions = req.app.locals.mastodonPluginOptions || {};
  return {
    federation: pluginOptions.federation,
    handle: pluginOptions.handle || "user",
    publicationUrl: pluginOptions.publicationUrl,
    collections: req.app.locals.mastodonCollections,
    loadRsaKey: pluginOptions.loadRsaKey,
  };
}

async function loadItemInteractions(collections, item) {
  const favouritedIds = new Set();
  const rebloggedIds = new Set();
  const bookmarkedIds = new Set();

  if (!collections.ap_interactions || !item.uid) {
    return { favouritedIds, rebloggedIds, bookmarkedIds };
  }

  const lookupUrls = [item.uid, item.url].filter(Boolean);
  const interactions = await collections.ap_interactions
    .find({ objectUrl: { $in: lookupUrls } })
    .toArray();

  for (const i of interactions) {
    const uid = item.uid;
    if (i.type === "like") favouritedIds.add(uid);
    else if (i.type === "boost") rebloggedIds.add(uid);
    else if (i.type === "bookmark") bookmarkedIds.add(uid);
  }

  return { favouritedIds, rebloggedIds, bookmarkedIds };
}

/**
 * Process status content: linkify bare URLs and convert @mentions to links.
 *
 * Mastodon clients send plain text — the server is responsible for
 * converting URLs and mentions into HTML links.
 *
 * @param {object} content - { text, html } from Micropub pipeline
 * @param {string} rawText - Original status text from client
 * @returns {object} { text, html } with linkified content
 */
function processStatusContent(content, rawText) {
  let html = content.html || content.text || rawText || "";

  // If the HTML is just plain text wrapped in <p>, process it
  // Don't touch HTML that already has links (from Micropub rendering)
  if (!html.includes("<a ")) {
    // Linkify bare URLs (http/https)
    html = html.replace(
      /(https?:\/\/[^\s<>"')\]]+)/g,
      '<a href="$1" rel="nofollow noopener noreferrer" target="_blank">$1</a>',
    );

    // Convert @user@domain mentions to profile links
    html = html.replace(
      /(?:^|\s)(@([a-zA-Z0-9_]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/g,
      (match, full, username, domain) =>
        match.replace(
          full,
          `<span class="h-card"><a href="https://${domain}/@${username}" class="u-url mention" rel="nofollow noopener noreferrer" target="_blank">@${username}@${domain}</a></span>`,
        ),
    );
  }

  return {
    text: content.text || rawText || "",
    html,
  };
}

/**
 * Extract @user@domain mentions from text into mention objects.
 *
 * @param {string} text - Status text
 * @returns {Array<{name: string, url: string}>} Mention objects
 */
function extractMentions(text) {
  if (!text) return [];
  const mentionRegex = /@([a-zA-Z0-9_]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const mentions = [];
  const seen = new Set();
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const [, username, domain] = match;
    const key = `${username}@${domain}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({
      name: `@${username}@${domain}`,
      url: `https://${domain}/@${username}`,
    });
  }
  return mentions;
}

export default router;
