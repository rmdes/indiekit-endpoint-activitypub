/**
 * Status endpoints for Mastodon Client API.
 *
 * GET /api/v1/statuses/:id — single status
 * GET /api/v1/statuses/:id/context — thread context (ancestors + descendants)
 * POST /api/v1/statuses — create post via Micropub pipeline
 * PUT /api/v1/statuses/:id — edit an existing post
 * DELETE /api/v1/statuses/:id — delete post via Micropub pipeline
 * GET /api/v1/statuses/:id/history — edit history
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
import { resolveReplyIds } from "../helpers/resolve-reply-ids.js";
import {
  likePost, unlikePost,
  boostPost, unboostPost,
  bookmarkPost, unbookmarkPost,
} from "../helpers/interactions.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/statuses/:id ───────────────────────────────────────────────

router.get("/api/v1/statuses/:id", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
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
    const { replyIdMap, replyAccountIdMap } = await resolveReplyIds(collections.ap_timeline, [item]);

    const status = serializeStatus(item, {
      baseUrl,
      ...interactionState,
      pinnedIds: new Set(),
      replyIdMap,
      replyAccountIdMap,
    });

    res.json(status);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/context ───────────────────────────────────────

router.get("/api/v1/statuses/:id/context", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
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

    const allItems = [...ancestors, ...descendants];
    const { replyIdMap, replyAccountIdMap } = await resolveReplyIds(collections.ap_timeline, allItems);
    const serializeOpts = { baseUrl, ...emptyInteractions, replyIdMap, replyAccountIdMap };

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

router.post("/api/v1/statuses", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
    const { application, publication } = req.app.locals;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    // Idempotency-Key support — prevent duplicate posts on client retry
    const idempotencyKey = req.headers["idempotency-key"];
    if (idempotencyKey && collections.ap_idempotency) {
      const { createHash } = await import("node:crypto");
      const key = createHash("sha256")
        .update(`${baseUrl}:${idempotencyKey}`)
        .digest("hex");
      const cached = await collections.ap_idempotency.findOne({ key });
      if (cached) {
        return res.json(cached.response);
      }
    }

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

    // Resolve media_ids to URLs from ap_media collection
    const mediaUrls = [];
    if (mediaIds && mediaIds.length > 0 && collections.ap_media) {
      const { ObjectId: MediaObjectId } = await import("mongodb");
      for (const mediaId of Array.isArray(mediaIds) ? mediaIds : [mediaIds]) {
        try {
          const media = await collections.ap_media.findOne({
            _id: new MediaObjectId(mediaId),
          });
          if (media) {
            mediaUrls.push({
              url: media.url,
              alt: media.description || "",
              type: media.mimeType,
            });
          }
        } catch {
          /* invalid ObjectId, skip */
        }
      }
    }

    // Build JF2 properties for the Micropub pipeline.
    // Provide both text and html — linkify URLs since Micropub's markdown-it
    // doesn't have linkify enabled. Mentions are preserved as plain text;
    // the AP syndicator resolves them via WebFinger for federation delivery.
    const contentText = statusText || "";
    const contentHtml = contentText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/(https?:\/\/[^\s<>&"')\]]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, "<br>");

    const jf2 = {
      type: "entry",
      content: { text: contentText, html: `<p>${contentHtml}</p>` },
    };

    if (inReplyTo) {
      jf2["in-reply-to"] = inReplyTo;
    }

    if (visibility && visibility !== "public") {
      jf2.visibility = visibility;
    }

    // Use content-warning (not summary) to match native reader behavior
    if (spoilerText) {
      jf2["content-warning"] = spoilerText;
      jf2.sensitive = "true";
    }

    if (language) {
      jf2["mp-language"] = language;
    }

    // Syndicate to AP — posts from Mastodon clients belong to the fediverse
    const publicationUrl = pluginOptions.publicationUrl || baseUrl;
    jf2["mp-syndicate-to"] = [publicationUrl.replace(/\/$/, "") + "/"];

    // Add media from media_ids
    for (const m of mediaUrls) {
      if (m.type?.startsWith("image/")) {
        if (!jf2.photo) jf2.photo = [];
        jf2.photo.push({ url: m.url, alt: m.alt });
      } else if (m.type?.startsWith("video/")) {
        if (!jf2.video) jf2.video = [];
        jf2.video.push(m.url);
      } else if (m.type?.startsWith("audio/")) {
        if (!jf2.audio) jf2.audio = [];
        jf2.audio.push(m.url);
      }
    }

    // Create post via Micropub pipeline (same internal functions)
    const { postData } = await import("@indiekit/endpoint-micropub/lib/post-data.js");
    const { postContent } = await import("@indiekit/endpoint-micropub/lib/post-content.js");

    const data = await postData.create(application, publication, jf2);
    await postContent.create(publication, data);

    const postUrl = data.properties.url;
    console.info(`[Mastodon API] Created post via Micropub: ${postUrl}`);

    // Return a minimal status to the Mastodon client.
    // No timeline entry is created here — the post will appear in the timeline
    // after the normal flow: Eleventy rebuild → syndication webhook → AP delivery.
    const profile = await collections.ap_profile.findOne({});
    const handle = pluginOptions.handle || "user";

    const statusResponse = {
      id: String(Date.now()),
      created_at: new Date().toISOString(),
      content: `<p>${contentHtml}</p>`,
      url: postUrl,
      uri: postUrl,
      visibility: visibility || "public",
      sensitive: sensitive === true || sensitive === "true",
      spoiler_text: spoilerText || "",
      in_reply_to_id: inReplyToId || null,
      in_reply_to_account_id: null,
      language: language || null,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      favourited: false,
      reblogged: false,
      bookmarked: false,
      account: {
        id: "owner",
        username: handle,
        acct: handle,
        display_name: profile?.name || handle,
        url: profile?.url || publicationUrl,
        avatar: profile?.icon || "",
        avatar_static: profile?.icon || "",
        header: "",
        header_static: "",
        followers_count: 0,
        following_count: 0,
        statuses_count: 0,
        emojis: [],
        fields: [],
      },
      media_attachments: [],
      mentions: extractMentions(contentText).map(m => ({
        id: "0",
        username: m.name.split("@")[1] || m.name,
        acct: m.name.replace(/^@/, ""),
        url: m.url,
      })),
      tags: [],
      emojis: [],
    };

    // Cache response for idempotency
    if (idempotencyKey && collections.ap_idempotency) {
      const { createHash } = await import("node:crypto");
      const key = createHash("sha256")
        .update(`${baseUrl}:${idempotencyKey}`)
        .digest("hex");
      await collections.ap_idempotency
        .insertOne({ key, response: statusResponse, createdAt: new Date() })
        .catch(() => {});
    }

    res.json(statusResponse);
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/statuses/:id ────────────────────────────────────────────
// Deletes via Micropub pipeline (removes content file + MongoDB post) and
// cleans up the ap_timeline entry.

router.delete("/api/v1/statuses/:id", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
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
    await collections.ap_timeline.deleteOne({ _id: item._id });

    // Clean up interactions
    if (collections.ap_interactions && item.uid) {
      await collections.ap_interactions.deleteMany({ objectUrl: item.uid });
    }

    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── PUT /api/v1/statuses/:id ───────────────────────────────────────────────
// Edit an existing status. Stores the previous version for history.

router.put("/api/v1/statuses/:id", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
    const { application, publication } = req.app.locals;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const localPublicationUrl = publication?.me || pluginOptions.publicationUrl || application?.url;

    const item = await findTimelineItemById(collections.ap_timeline, req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Verify ownership — only the local author can edit
    if (!item.author?.url || item.author.url !== localPublicationUrl) {
      return res.status(403).json({ error: "This action is not allowed" });
    }

    const {
      status: statusText,
      spoiler_text: spoilerText,
      sensitive,
      language,
    } = req.body;

    // Store current version in edit history
    if (collections.ap_status_edits) {
      await collections.ap_status_edits.insertOne({
        statusId: req.params.id,
        content: item.content || {},
        summary: item.summary || "",
        sensitive: item.sensitive || false,
        media: [
          ...(item.photo || []),
          ...(item.video || []),
          ...(item.audio || []),
        ],
        editedAt: new Date().toISOString(),
      });
    }

    // Send update via Micropub
    const postUrl = item.uid || item.url;
    if (postUrl && application.micropubEndpoint) {
      const micropubUrl = application.micropubEndpoint.startsWith("http")
        ? application.micropubEndpoint
        : new URL(application.micropubEndpoint, application.url).href;

      const token =
        req.session?.access_token || req.mastodonToken?.accessToken;
      if (token) {
        const updatePayload = {
          action: "update",
          url: postUrl,
          replace: {},
        };

        if (statusText !== undefined) {
          updatePayload.replace.content = [statusText];
        }

        try {
          await fetch(micropubUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(updatePayload),
          });
        } catch (err) {
          console.warn(
            `[Mastodon API] Micropub update failed: ${err.message}`,
          );
        }
      }
    }

    // Update timeline item directly
    const updateFields = {};
    if (statusText !== undefined) {
      const contentHtml = statusText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(
          /(https?:\/\/[^\s<>&"')\]]+)/g,
          '<a href="$1">$1</a>',
        )
        .replace(/\n/g, "<br>");
      updateFields["content.text"] = statusText;
      updateFields["content.html"] = contentHtml;
    }
    if (spoilerText !== undefined) updateFields.summary = spoilerText;
    if (sensitive !== undefined)
      updateFields.sensitive = sensitive === "true" || sensitive === true;
    if (language !== undefined) updateFields.language = language;
    updateFields.updatedAt = new Date().toISOString();

    await collections.ap_timeline.updateOne(
      { _id: item._id },
      { $set: updateFields },
    );

    // Reload and serialize
    const updated = await collections.ap_timeline.findOne({
      _id: item._id,
    });
    const { serializeStatus, setLocalIdentity } = await import(
      "../entities/status.js"
    );
    const handle = pluginOptions.actor?.handle || "";
    setLocalIdentity(localPublicationUrl, handle);

    const serialized = serializeStatus(updated, { baseUrl });
    res.json(serialized);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/history ───────────────────────────────────────

router.get("/api/v1/statuses/:id/history", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(collections.ap_timeline, req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const edits = collections.ap_status_edits
      ? await collections.ap_status_edits
          .find({ statusId: req.params.id })
          .sort({ editedAt: 1 })
          .toArray()
      : [];

    const { serializeAccount } = await import("../entities/account.js");
    const localPublicationUrl = pluginOptions.publicationUrl || baseUrl;
    const handle = pluginOptions.actor?.handle || "";

    const accountObj = item.author
      ? serializeAccount(item.author, {
          baseUrl,
          isLocal: item.author.url === localPublicationUrl,
          handle,
        })
      : null;

    // Build history: each edit snapshot + current version as latest
    const history = edits.map((edit) => ({
      content: edit.content?.html || edit.content?.text || "",
      spoiler_text: edit.summary || "",
      sensitive: edit.sensitive || false,
      created_at: edit.editedAt,
      account: accountObj,
      media_attachments: [],
      emojis: [],
    }));

    // Add current version as the latest entry
    history.push({
      content: item.content?.html || item.content?.text || "",
      spoiler_text: item.summary || "",
      sensitive: item.sensitive || false,
      created_at: item.updatedAt || item.published || item.createdAt,
      account: accountObj,
      media_attachments: [],
      emojis: [],
    });

    res.json(history);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/favourited_by ─────────────────────────────────

router.get("/api/v1/statuses/:id/favourited_by", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(
      collections.ap_timeline,
      req.params.id,
    );
    if (!item) return res.status(404).json({ error: "Record not found" });

    const uid = item.uid || item.url;
    if (!uid || !collections.ap_interactions) return res.json([]);

    const interactions = await collections.ap_interactions
      .find({ objectUrl: uid, type: "like" })
      .limit(40)
      .toArray();

    const { serializeAccount } = await import("../entities/account.js");
    const accounts = interactions
      .filter((i) => i.actorUrl || i.actorName)
      .map((i) =>
        serializeAccount(
          {
            url: i.actorUrl,
            name: i.actorName || "",
            handle: i.actorHandle || "",
          },
          { baseUrl, isLocal: false },
        ),
      );

    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/statuses/:id/reblogged_by ──────────────────────────────────

router.get("/api/v1/statuses/:id/reblogged_by", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const item = await findTimelineItemById(
      collections.ap_timeline,
      req.params.id,
    );
    if (!item) return res.status(404).json({ error: "Record not found" });

    const uid = item.uid || item.url;
    if (!uid || !collections.ap_interactions) return res.json([]);

    const interactions = await collections.ap_interactions
      .find({ objectUrl: uid, type: "boost" })
      .limit(40)
      .toArray();

    const { serializeAccount } = await import("../entities/account.js");
    const accounts = interactions
      .filter((i) => i.actorUrl || i.actorName)
      .map((i) =>
        serializeAccount(
          {
            url: i.actorUrl,
            name: i.actorName || "",
            handle: i.actorHandle || "",
          },
          { baseUrl, isLocal: false },
        ),
      );

    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/statuses/:id/favourite ────────────────────────────────────

router.post("/api/v1/statuses/:id/favourite", tokenRequired, scopeRequired("write", "write:favourites"), async (req, res, next) => {
  try {
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

router.post("/api/v1/statuses/:id/unfavourite", tokenRequired, scopeRequired("write", "write:favourites"), async (req, res, next) => {
  try {
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

router.post("/api/v1/statuses/:id/reblog", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
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

router.post("/api/v1/statuses/:id/unreblog", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
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

router.post("/api/v1/statuses/:id/bookmark", tokenRequired, scopeRequired("write", "write:bookmarks"), async (req, res, next) => {
  try {
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

router.post("/api/v1/statuses/:id/unbookmark", tokenRequired, scopeRequired("write", "write:bookmarks"), async (req, res, next) => {
  try {
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

// ─── GET /api/v1/statuses/:id/card ──────────────────────────────────────────

router.get("/api/v1/statuses/:id/card", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const item = await findTimelineItemById(
      collections.ap_timeline,
      req.params.id,
    );
    if (!item) {
      return res.status(404).json({ error: "Record not found" });
    }

    const { serializeCard } = await import("../entities/status.js");
    const card = serializeCard(item.linkPreviews?.[0]);
    if (!card) {
      return res.json({});
    }

    res.json(card);
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
