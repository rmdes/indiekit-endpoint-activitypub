/**
 * Timeline endpoints for Mastodon Client API.
 *
 * GET /api/v1/timelines/home — home timeline (authenticated)
 * GET /api/v1/timelines/public — public/federated timeline
 * GET /api/v1/timelines/tag/:hashtag — hashtag timeline
 *
 * ADAPTER ONLY. Query construction, ordering, visibility rules and read state
 * live in lib/core/timeline.js — this file parses Mastodon's parameters, calls
 * core once, and serialises the result. It must contain no business rules and
 * no database queries (plan §3; CI rule 5.2 lands in Stage 5).
 *
 * Behaviour changes from the port, all ratified:
 *   DD-1  ordering is now arrival (`receivedAt`), not insertion-order `_id`.
 *         Same practical result for this lane — it already sorted by arrival —
 *         but backfilled thread ancestors no longer surface at the top.
 *   DD-3  reading the timeline marks items read for BOTH surfaces.
 *   DD-4  the reader now matches this lane on followers-only posts.
 */
import express from "express";

import {
  getLocalActorUrl,
  getTimeline,
  markRead,
} from "../../core/timeline.js";
import { loadModerationData, applyModerationFilters } from "../../item-processing.js";
import { serializeStatus } from "../entities/status.js";
import { setCursorHeaders } from "../helpers/pagination.js";
import { resolveReplyIds } from "../helpers/resolve-reply-ids.js";
import { enrichAccountStats } from "../helpers/enrich-accounts.js";
import { loadUserFilters, applyFilters } from "../helpers/apply-filters.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

/** Map Mastodon's cursor params onto core's opaque ones. */
function pageParams(query) {
  return {
    limit: query.limit,
    before: query.max_id,
    after: query.since_id,
    since: query.min_id,
  };
}

/**
 * Shared pipeline: core query → moderation → serialise → enrich → filter.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} coreOptions - passed straight to core/timeline#getTimeline
 * @param {object} [opts]
 * @param {string} [opts.filterContext] - Mastodon filter context ("home"|"public")
 * @param {boolean} [opts.markAsRead] - mark served items read (DD-3)
 */
async function serveTimeline(req, res, coreOptions, opts = {}) {
  const collections = req.app.locals.mastodonCollections;
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const { items, before, after } = await getTimeline(collections, coreOptions);

  const moderation = await loadModerationData({
    ap_muted: collections.ap_muted,
    ap_blocked: collections.ap_blocked,
    ap_profile: collections.ap_profile,
  });
  const visible = applyModerationFilters(items, moderation);

  const interactionState = await loadInteractionState(collections, visible);
  const { replyIdMap, replyAccountIdMap } = await resolveReplyIds(
    collections.ap_timeline,
    visible,
  );

  const statuses = visible.map((item) =>
    serializeStatus(item, {
      baseUrl,
      ...interactionState,
      pinnedIds: new Set(),
      replyIdMap,
      replyAccountIdMap,
    }),
  );

  // Phanpy never calls /accounts/:id — it trusts embedded account data.
  const pluginOptions = req.app.locals.mastodonPluginOptions || {};
  await enrichAccountStats(statuses, pluginOptions, baseUrl, collections);

  let result = statuses;
  if (collections.ap_filters && opts.filterContext) {
    const filters = await loadUserFilters(collections, opts.filterContext);
    result = applyFilters(statuses, filters);
  }

  // DD-3: serving the timeline marks it read, so the desktop reader and the
  // phone share one unread state.
  //
  // Awaited rather than fire-and-forget: it is one indexed updateMany over ~20
  // uids, and making it deterministic matters more than the microseconds. A
  // detached write also makes read state racy from the client's perspective —
  // fetch, then immediately query unread, and the answer depends on timing.
  // A failure here must not fail the request, hence the catch.
  if (opts.markAsRead && visible.length > 0) {
    try {
      await markRead(
        collections,
        visible.map((i) => i.uid).filter(Boolean),
      );
    } catch (error) {
      console.warn("[Mastodon API] markRead failed:", error.message);
    }
  }

  setCursorHeaders(res, req, { before, after });
  res.json(result);
}

// ─── GET /api/v1/timelines/home ─────────────────────────────────────────────

router.get(
  "/api/v1/timelines/home",
  tokenRequired,
  scopeRequired("read", "read:statuses"),
  async (req, res, next) => {
    try {
      await serveTimeline(
        req,
        res,
        { feed: "home", ...pageParams(req.query) },
        { filterContext: "home", markAsRead: true },
      );
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /api/v1/timelines/public ───────────────────────────────────────────

router.get("/api/v1/timelines/public", async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;

    let origin;
    let localAuthorUrl;
    if (req.query.local === "true" || req.query.remote === "true") {
      localAuthorUrl = await getLocalActorUrl(collections);
      if (localAuthorUrl) {
        origin = req.query.local === "true" ? "local" : "remote";
      }
    }

    await serveTimeline(
      req,
      res,
      {
        feed: "public",
        excludeReplies: true,
        onlyMedia: req.query.only_media === "true",
        origin,
        localAuthorUrl,
        ...pageParams(req.query),
      },
      { filterContext: "public" },
    );
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/timelines/tag/:hashtag ─────────────────────────────────────

router.get("/api/v1/timelines/tag/:hashtag", async (req, res, next) => {
  try {
    await serveTimeline(
      req,
      res,
      {
        feed: "tag",
        tag: req.params.hashtag,
        excludeReplies: true,
        ...pageParams(req.query),
      },
      { filterContext: "public" },
    );
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load favourite/boost/bookmark state for a set of items.
 *
 * Stays here rather than in core: "favourited" is a Mastodon Status field, and
 * core has no opinion about it.
 *
 * @param {object} collections
 * @param {Array} items
 * @returns {Promise<{favouritedIds: Set, rebloggedIds: Set, bookmarkedIds: Set}>}
 */
async function loadInteractionState(collections, items) {
  const favouritedIds = new Set();
  const rebloggedIds = new Set();
  const bookmarkedIds = new Set();

  if (!items.length || !collections.ap_interactions) {
    return { favouritedIds, rebloggedIds, bookmarkedIds };
  }

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
    if (interaction.type === "like") favouritedIds.add(uid);
    else if (interaction.type === "boost") rebloggedIds.add(uid);
    else if (interaction.type === "bookmark") bookmarkedIds.add(uid);
  }

  return { favouritedIds, rebloggedIds, bookmarkedIds };
}

export default router;
