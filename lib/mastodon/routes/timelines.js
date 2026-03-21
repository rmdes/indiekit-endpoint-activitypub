/**
 * Timeline endpoints for Mastodon Client API.
 *
 * GET /api/v1/timelines/home — home timeline (authenticated)
 * GET /api/v1/timelines/public — public/federated timeline
 * GET /api/v1/timelines/tag/:hashtag — hashtag timeline
 */
import express from "express";
import { serializeStatus } from "../entities/status.js";
import { buildPaginationQuery, parseLimit, setPaginationHeaders } from "../helpers/pagination.js";
import { loadModerationData, applyModerationFilters } from "../../item-processing.js";
import { enrichAccountStats } from "../helpers/enrich-accounts.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/timelines/home ─────────────────────────────────────────────

router.get("/api/v1/timelines/home", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    // Base filter: exclude context-only items and private/direct posts
    const baseFilter = {
      isContext: { $ne: true },
      visibility: { $nin: ["direct"] },
    };

    // Apply cursor-based pagination
    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    // Fetch items from timeline
    let items = await collections.ap_timeline
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    // Reverse if min_id was used (ascending sort → need descending order)
    if (reverse) {
      items.reverse();
    }

    // Apply mute/block filtering
    const modCollections = {
      ap_muted: collections.ap_muted,
      ap_blocked: collections.ap_blocked,
      ap_profile: collections.ap_profile,
    };
    const moderation = await loadModerationData(modCollections);
    items = applyModerationFilters(items, moderation);

    // Load interaction state (likes, boosts, bookmarks) for the authenticated user
    const { favouritedIds, rebloggedIds, bookmarkedIds } = await loadInteractionState(
      collections,
      items,
    );

    // Serialize to Mastodon Status entities
    const statuses = items.map((item) =>
      serializeStatus(item, {
        baseUrl,
        favouritedIds,
        rebloggedIds,
        bookmarkedIds,
        pinnedIds: new Set(),
      }),
    );

    // Enrich embedded account objects with real follower/following/post counts.
    // Phanpy never calls /accounts/:id — it trusts embedded account data.
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    await enrichAccountStats(statuses, pluginOptions, baseUrl);

    // Set pagination Link headers
    setPaginationHeaders(res, req, items, limit);

    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/timelines/public ───────────────────────────────────────────

router.get("/api/v1/timelines/public", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    // Public timeline: only public visibility, no context items
    const baseFilter = {
      isContext: { $ne: true },
      visibility: "public",
    };

    // Local timeline: only posts from the local instance author
    if (req.query.local === "true") {
      const profile = await collections.ap_profile.findOne({});
      if (profile?.url) {
        baseFilter["author.url"] = profile.url;
      }
    }

    // Remote-only: exclude local author posts
    if (req.query.remote === "true") {
      const profile = await collections.ap_profile.findOne({});
      if (profile?.url) {
        baseFilter["author.url"] = { $ne: profile.url };
      }
    }

    if (req.query.only_media === "true") {
      baseFilter.$or = [
        { "photo.0": { $exists: true } },
        { "video.0": { $exists: true } },
        { "audio.0": { $exists: true } },
      ];
    }

    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    let items = await collections.ap_timeline
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    if (reverse) {
      items.reverse();
    }

    // Apply mute/block filtering
    const modCollections = {
      ap_muted: collections.ap_muted,
      ap_blocked: collections.ap_blocked,
      ap_profile: collections.ap_profile,
    };
    const moderation = await loadModerationData(modCollections);
    items = applyModerationFilters(items, moderation);

    // Load interaction state if authenticated
    let favouritedIds = new Set();
    let rebloggedIds = new Set();
    let bookmarkedIds = new Set();

    if (req.mastodonToken) {
      ({ favouritedIds, rebloggedIds, bookmarkedIds } = await loadInteractionState(
        collections,
        items,
      ));
    }

    const statuses = items.map((item) =>
      serializeStatus(item, {
        baseUrl,
        favouritedIds,
        rebloggedIds,
        bookmarkedIds,
        pinnedIds: new Set(),
      }),
    );

    const pluginOpts = req.app.locals.mastodonPluginOptions || {};
    await enrichAccountStats(statuses, pluginOpts, baseUrl);

    setPaginationHeaders(res, req, items, limit);
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/timelines/tag/:hashtag ─────────────────────────────────────

router.get("/api/v1/timelines/tag/:hashtag", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);
    const hashtag = req.params.hashtag;

    const baseFilter = {
      isContext: { $ne: true },
      visibility: { $in: ["public", "unlisted"] },
      category: hashtag,
    };

    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    let items = await collections.ap_timeline
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    if (reverse) {
      items.reverse();
    }

    // Load interaction state if authenticated
    let favouritedIds = new Set();
    let rebloggedIds = new Set();
    let bookmarkedIds = new Set();

    if (req.mastodonToken) {
      ({ favouritedIds, rebloggedIds, bookmarkedIds } = await loadInteractionState(
        collections,
        items,
      ));
    }

    const statuses = items.map((item) =>
      serializeStatus(item, {
        baseUrl,
        favouritedIds,
        rebloggedIds,
        bookmarkedIds,
        pinnedIds: new Set(),
      }),
    );

    const pluginOpts = req.app.locals.mastodonPluginOptions || {};
    await enrichAccountStats(statuses, pluginOpts, baseUrl);

    setPaginationHeaders(res, req, items, limit);
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load interaction state (favourited, reblogged, bookmarked) for a set of timeline items.
 *
 * Queries ap_interactions for likes and boosts matching the items' UIDs.
 *
 * @param {object} collections - MongoDB collections
 * @param {Array} items - Timeline items
 * @returns {Promise<{ favouritedIds: Set<string>, rebloggedIds: Set<string>, bookmarkedIds: Set<string> }>}
 */
async function loadInteractionState(collections, items) {
  const favouritedIds = new Set();
  const rebloggedIds = new Set();
  const bookmarkedIds = new Set();

  if (!items.length || !collections.ap_interactions) {
    return { favouritedIds, rebloggedIds, bookmarkedIds };
  }

  // Collect all UIDs and URLs to look up
  const lookupUrls = new Set();
  const urlToUid = new Map();
  for (const item of items) {
    if (item.uid) {
      lookupUrls.add(item.uid);
      urlToUid.set(item.uid, item.uid);
    }
    if (item.url && item.url !== item.uid) {
      lookupUrls.add(item.url);
      urlToUid.set(item.url, item.uid || item.url);
    }
  }

  if (lookupUrls.size === 0) {
    return { favouritedIds, rebloggedIds, bookmarkedIds };
  }

  const interactions = await collections.ap_interactions
    .find({ objectUrl: { $in: [...lookupUrls] } })
    .toArray();

  for (const interaction of interactions) {
    const uid = urlToUid.get(interaction.objectUrl) || interaction.objectUrl;
    if (interaction.type === "like") {
      favouritedIds.add(uid);
    } else if (interaction.type === "boost") {
      rebloggedIds.add(uid);
    } else if (interaction.type === "bookmark") {
      bookmarkedIds.add(uid);
    }
  }

  return { favouritedIds, rebloggedIds, bookmarkedIds };
}

export default router;
