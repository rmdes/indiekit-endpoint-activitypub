/**
 * Stub and lightweight endpoints for Mastodon Client API.
 *
 * Some endpoints have real implementations (markers, bookmarks, favourites).
 * Others return empty/minimal responses to prevent client errors.
 *
 * Phanpy calls these on startup, navigation, and various page loads:
 * - markers (BackgroundService, every page load)
 * - follow_requests (home + notifications pages)
 * - announcements (notifications page)
 * - custom_emojis (compose screen)
 * - filters (status rendering)
 * - lists (sidebar navigation)
 * - mutes, blocks (nav menu)
 * - featured_tags (profile view)
 * - bookmarks, favourites (dedicated pages)
 * - trends (explore page)
 * - followed_tags (followed tags page)
 * - suggestions (explore page)
 */
import express from "express";
import { serializeStatus } from "../entities/status.js";
import { parseLimit, buildPaginationQuery, setPaginationHeaders } from "../helpers/pagination.js";
import { getFollowedTagsWithState } from "../../storage/followed-tags.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── Markers ────────────────────────────────────────────────────────────────

router.get("/api/v1/markers", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const timelines = [].concat(req.query["timeline[]"] || req.query.timeline || []);

    if (!timelines.length || !collections.ap_markers) {
      return res.json({});
    }

    const docs = await collections.ap_markers
      .find({ timeline: { $in: timelines } })
      .toArray();

    const result = {};
    for (const doc of docs) {
      result[doc.timeline] = {
        last_read_id: doc.last_read_id,
        version: doc.version || 0,
        updated_at: doc.updated_at || new Date().toISOString(),
      };
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/api/v1/markers", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections.ap_markers) {
      return res.json({});
    }

    const result = {};
    for (const timeline of ["home", "notifications"]) {
      const data = req.body[timeline];
      if (!data?.last_read_id) continue;

      const now = new Date().toISOString();
      await collections.ap_markers.updateOne(
        { timeline },
        {
          $set: { last_read_id: data.last_read_id, updated_at: now },
          $inc: { version: 1 },
          $setOnInsert: { timeline },
        },
        { upsert: true },
      );

      const doc = await collections.ap_markers.findOne({ timeline });
      result[timeline] = {
        last_read_id: doc.last_read_id,
        version: doc.version || 0,
        updated_at: doc.updated_at || now,
      };
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ─── Follow requests ────────────────────────────────────────────────────────

router.get("/api/v1/follow_requests", (req, res) => {
  res.json([]);
});

// ─── Announcements ──────────────────────────────────────────────────────────

router.get("/api/v1/announcements", (req, res) => {
  res.json([]);
});

// ─── Custom emojis ──────────────────────────────────────────────────────────

router.get("/api/v1/custom_emojis", (req, res) => {
  res.json([]);
});

// ─── Filters (v2) ───────────────────────────────────────────────────────────

router.get("/api/v2/filters", (req, res) => {
  res.json([]);
});

router.get("/api/v1/filters", (req, res) => {
  res.json([]);
});

// ─── Lists ──────────────────────────────────────────────────────────────────

router.get("/api/v1/lists", (req, res) => {
  res.json([]);
});

// ─── Mutes ──────────────────────────────────────────────────────────────────

router.get("/api/v1/mutes", (req, res) => {
  res.json([]);
});

// ─── Blocks ─────────────────────────────────────────────────────────────────

router.get("/api/v1/blocks", (req, res) => {
  res.json([]);
});

// ─── Bookmarks ──────────────────────────────────────────────────────────────

router.get("/api/v1/bookmarks", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    if (!collections.ap_interactions) {
      return res.json([]);
    }

    const baseFilter = { type: "bookmark" };
    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    let interactions = await collections.ap_interactions
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    if (reverse) interactions.reverse();

    // Batch-fetch the actual timeline items
    const objectUrls = interactions.map((i) => i.objectUrl).filter(Boolean);
    if (!objectUrls.length) {
      return res.json([]);
    }

    const items = await collections.ap_timeline
      .find({ $or: [{ uid: { $in: objectUrls } }, { url: { $in: objectUrls } }] })
      .toArray();

    const itemMap = new Map();
    for (const item of items) {
      if (item.uid) itemMap.set(item.uid, item);
      if (item.url) itemMap.set(item.url, item);
    }

    const statuses = [];
    for (const interaction of interactions) {
      const item = itemMap.get(interaction.objectUrl);
      if (item) {
        statuses.push(
          serializeStatus(item, {
            baseUrl,
            favouritedIds: new Set(),
            rebloggedIds: new Set(),
            bookmarkedIds: new Set([item.uid]),
            pinnedIds: new Set(),
          }),
        );
      }
    }

    setPaginationHeaders(res, req, interactions, limit);
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── Favourites ─────────────────────────────────────────────────────────────

router.get("/api/v1/favourites", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    if (!collections.ap_interactions) {
      return res.json([]);
    }

    const baseFilter = { type: "like" };
    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    let interactions = await collections.ap_interactions
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    if (reverse) interactions.reverse();

    const objectUrls = interactions.map((i) => i.objectUrl).filter(Boolean);
    if (!objectUrls.length) {
      return res.json([]);
    }

    const items = await collections.ap_timeline
      .find({ $or: [{ uid: { $in: objectUrls } }, { url: { $in: objectUrls } }] })
      .toArray();

    const itemMap = new Map();
    for (const item of items) {
      if (item.uid) itemMap.set(item.uid, item);
      if (item.url) itemMap.set(item.url, item);
    }

    const statuses = [];
    for (const interaction of interactions) {
      const item = itemMap.get(interaction.objectUrl);
      if (item) {
        statuses.push(
          serializeStatus(item, {
            baseUrl,
            favouritedIds: new Set([item.uid]),
            rebloggedIds: new Set(),
            bookmarkedIds: new Set(),
            pinnedIds: new Set(),
          }),
        );
      }
    }

    setPaginationHeaders(res, req, interactions, limit);
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── Featured tags ──────────────────────────────────────────────────────────

router.get("/api/v1/featured_tags", (req, res) => {
  res.json([]);
});

// ─── Followed tags ──────────────────────────────────────────────────────────

router.get("/api/v1/followed_tags", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections?.ap_followed_tags) {
      return res.json([]);
    }

    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const publicationUrl = pluginOptions.publicationUrl || "";
    const tags = await getFollowedTagsWithState({ ap_followed_tags: collections.ap_followed_tags });

    const response = tags.map((doc) => ({
      id: doc._id.toString(),
      name: doc.tag,
      url: `${publicationUrl.replace(/\/$/, "")}/tags/${doc.tag}`,
      history: [],
      following: true,
    }));

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// ─── Suggestions ────────────────────────────────────────────────────────────

router.get("/api/v2/suggestions", (req, res) => {
  res.json([]);
});

// ─── Trends ─────────────────────────────────────────────────────────────────

router.get("/api/v1/trends/statuses", (req, res) => {
  res.json([]);
});

router.get("/api/v1/trends/tags", (req, res) => {
  res.json([]);
});

router.get("/api/v1/trends/links", (req, res) => {
  res.json([]);
});

// ─── Scheduled statuses ─────────────────────────────────────────────────────

router.get("/api/v1/scheduled_statuses", (req, res) => {
  res.json([]);
});

// ─── Conversations ──────────────────────────────────────────────────────────

router.get("/api/v1/conversations", (req, res) => {
  res.json([]);
});

// ─── Domain blocks ──────────────────────────────────────────────────────────

router.get("/api/v1/domain_blocks", async (req, res) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections?.ap_blocked_servers) return res.json([]);
    const docs = await collections.ap_blocked_servers.find({}).toArray();
    res.json(docs.map((d) => d.hostname).filter(Boolean));
  } catch {
    res.json([]);
  }
});

// ─── Endorsements ───────────────────────────────────────────────────────────

router.get("/api/v1/endorsements", (req, res) => {
  res.json([]);
});

// ─── Account statuses ───────────────────────────────────────────────────────

router.get("/api/v1/accounts/:id/statuses", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    // Try to find the profile to see if this is the local user
    const profile = await collections.ap_profile.findOne({});
    const isLocal = profile && profile._id.toString() === req.params.id;

    if (isLocal && profile?.url) {
      // Return statuses authored by local user
      const { serializeStatus } = await import("../entities/status.js");
      const { parseLimit } = await import("../helpers/pagination.js");

      const limit = parseLimit(req.query.limit);
      const items = await collections.ap_timeline
        .find({ "author.url": profile.url, isContext: { $ne: true } })
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();

      const statuses = items.map((item) =>
        serializeStatus(item, {
          baseUrl,
          favouritedIds: new Set(),
          rebloggedIds: new Set(),
          bookmarkedIds: new Set(),
          pinnedIds: new Set(),
        }),
      );

      return res.json(statuses);
    }

    // Remote account or unknown — return empty
    res.json([]);
  } catch (error) {
    next(error);
  }
});

// ─── Account followers/following ────────────────────────────────────────────

router.get("/api/v1/accounts/:id/followers", (req, res) => {
  res.json([]);
});

router.get("/api/v1/accounts/:id/following", (req, res) => {
  res.json([]);
});

export default router;
