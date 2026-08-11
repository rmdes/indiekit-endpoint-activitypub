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
import { serializeAccount } from "../entities/account.js";
import { parseLimit, buildPaginationQuery, setPaginationHeaders } from "../helpers/pagination.js";
import { getFollowedTagsWithState } from "../../storage/followed-tags.js";
import { getMutedAccounts } from "../../core/moderation.js";
import {
  approveFollow,
  findPendingBy,
  rejectFollow,
} from "../../core/follow-requests.js";
import { remoteActorId } from "../helpers/id-mapping.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── Markers ────────────────────────────────────────────────────────────────

router.get("/api/v1/markers", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
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

router.post("/api/v1/markers", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
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

router.get("/api/v1/follow_requests", tokenRequired, scopeRequired("read", "read:follows"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    if (!collections.ap_pending_follows) return res.json([]);
    const pending = await collections.ap_pending_follows.find({}).toArray();
    res.json(pending.map((p) =>
      serializeAccount(
        { name: p.name, url: p.actorUrl, photo: p.avatar || p.photo, handle: p.handle },
        { baseUrl },
      ),
    ).filter(Boolean));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/follow_requests/:id/authorize | /reject ───────────────────
//
// AP-D8: GET /follow_requests has listed pending requests since v3.13.21, but
// there was no way to action one from a client — the reader had approve/reject
// and the API had neither. A visible request that cannot be accepted is a dead
// control, and arguably worse than an invisible one.
//
// DD-5: core keys on the actor URI. This adapter mints ids the same way
// serializeAccount does — sha256(url) truncated — and passes core a matcher
// rather than an id core would have to understand.

/**
 * Resolve a Mastodon account id back to a pending follow request.
 */
async function pendingForAccountId(collections, id) {
  return findPendingBy(collections, (actorUrl) => remoteActorId(actorUrl) === id);
}

/** Federation options for core, from the plugin wiring on app.locals. */
function federationOpts(req) {
  const opts = req.app.locals.mastodonPluginOptions || {};
  return {
    federation: opts.federation,
    handle: opts.handle,
    publicationUrl: opts.publicationUrl,
  };
}

router.post(
  "/api/v1/follow_requests/:id/authorize",
  tokenRequired,
  scopeRequired("write", "write:follows", "follow"),
  async (req, res, next) => {
    try {
      const collections = req.app.locals.mastodonCollections;
      const pending = await pendingForAccountId(collections, req.params.id);

      if (!pending) {
        return res.status(404).json({ error: "Record not found" });
      }

      const result = await approveFollow(
        collections,
        pending.actorUrl,
        federationOpts(req),
      );

      if (!result.ok) {
        return res.status(422).json({ error: result.error });
      }

      // Mastodon returns the Relationship for the now-accepted follower.
      res.json({
        id: req.params.id,
        following: false,
        showing_reblogs: true,
        notifying: false,
        followed_by: true,
        blocking: false,
        blocked_by: false,
        muting: false,
        muting_notifications: false,
        requested: false,
        domain_blocking: false,
        endorsed: false,
        note: "",
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/api/v1/follow_requests/:id/reject",
  tokenRequired,
  scopeRequired("write", "write:follows", "follow"),
  async (req, res, next) => {
    try {
      const collections = req.app.locals.mastodonCollections;
      const pending = await pendingForAccountId(collections, req.params.id);

      if (!pending) {
        return res.status(404).json({ error: "Record not found" });
      }

      const result = await rejectFollow(
        collections,
        pending.actorUrl,
        federationOpts(req),
      );

      if (!result.ok) {
        return res.status(422).json({ error: result.error });
      }

      res.json({
        id: req.params.id,
        following: false,
        showing_reblogs: true,
        notifying: false,
        followed_by: false,
        blocking: false,
        blocked_by: false,
        muting: false,
        muting_notifications: false,
        requested: false,
        domain_blocking: false,
        endorsed: false,
        note: "",
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── Announcements ──────────────────────────────────────────────────────────

router.get("/api/v1/announcements", (req, res) => {
  res.json([]);
});

// ─── Custom emojis ──────────────────────────────────────────────────────────

router.get("/api/v1/custom_emojis", (req, res) => {
  res.json([]);
});

// ─── Lists ──────────────────────────────────────────────────────────────────

router.get("/api/v1/lists", (req, res) => {
  res.json([]);
});

// ─── Mutes ──────────────────────────────────────────────────────────────────

// AP-D9: this previously returned [] on the premise that ap_muted holds only
// keyword mutes. That was false — it holds BOTH, keyed by which field is
// present, and routes/accounts.js has always read the url-keyed ones to build
// `muted` on the relationships endpoint. So POST /accounts/:id/mute wrote a
// record this endpoint could not read back, and the same client reported
// muted:true on one endpoint and an empty list on another.
router.get("/api/v1/mutes", tokenRequired, scopeRequired("read", "read:mutes"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const muted = await getMutedAccounts(collections);

    res.json(
      muted
        .map((m) => serializeAccount({ url: m.url }, { baseUrl }))
        .filter(Boolean),
    );
  } catch (error) {
    next(error);
  }
});

// ─── Blocks ─────────────────────────────────────────────────────────────────

router.get("/api/v1/blocks", tokenRequired, scopeRequired("read", "read:blocks"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    if (!collections.ap_blocked) return res.json([]);
    const blocked = await collections.ap_blocked.find({ url: { $exists: true } }).toArray();
    res.json(blocked.map((b) => serializeAccount({ url: b.url }, { baseUrl })).filter(Boolean));
  } catch (error) {
    next(error);
  }
});

// ─── Bookmarks ──────────────────────────────────────────────────────────────

router.get("/api/v1/bookmarks", tokenRequired, scopeRequired("read", "read:bookmarks"), async (req, res, next) => {
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

router.get("/api/v1/favourites", tokenRequired, scopeRequired("read", "read:favourites"), async (req, res, next) => {
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

// ─── GET /api/v1/tags/:id ───────────────────────────────────────────────────

router.get("/api/v1/tags/:id", async (req, res) => {
  const collections = req.app.locals.mastodonCollections;
  const tag = req.params.id.toLowerCase().replace(/^#/, "");
  let following = false;

  if (collections.ap_followed_tags) {
    const doc = await collections.ap_followed_tags.findOne({ tag });
    following = !!doc;
  }

  res.json({
    name: tag,
    url: `${req.protocol}://${req.get("host")}/tags/${tag}`,
    history: [],
    following,
  });
});

// ─── POST /api/v1/tags/:id/follow ──────────────────────────────────────────

router.post("/api/v1/tags/:id/follow", tokenRequired, scopeRequired("write", "write:follows"), async (req, res) => {
  const collections = req.app.locals.mastodonCollections;
  const tag = req.params.id.toLowerCase().replace(/^#/, "");

  if (collections.ap_followed_tags) {
    await collections.ap_followed_tags.updateOne(
      { tag },
      { $setOnInsert: { tag, createdAt: new Date().toISOString() } },
      { upsert: true },
    );
  }

  res.json({
    name: tag,
    url: `${req.protocol}://${req.get("host")}/tags/${tag}`,
    history: [],
    following: true,
  });
});

// ─── POST /api/v1/tags/:id/unfollow ────────────────────────────────────────

router.post("/api/v1/tags/:id/unfollow", tokenRequired, scopeRequired("write", "write:follows"), async (req, res) => {
  const collections = req.app.locals.mastodonCollections;
  const tag = req.params.id.toLowerCase().replace(/^#/, "");

  if (collections.ap_followed_tags) {
    await collections.ap_followed_tags.deleteOne({ tag });
  }

  res.json({
    name: tag,
    url: `${req.protocol}://${req.get("host")}/tags/${tag}`,
    history: [],
    following: false,
  });
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

// ─── POST /api/v1/domain_blocks ─────────────────────────────────────────────

router.post("/api/v1/domain_blocks", tokenRequired, scopeRequired("write", "write:blocks"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const domain = req.body.domain?.trim();

    if (!domain) {
      return res.status(422).json({ error: "domain is required" });
    }

    if (collections.ap_blocked_servers) {
      await collections.ap_blocked_servers.updateOne(
        { hostname: domain },
        { $setOnInsert: { hostname: domain, createdAt: new Date().toISOString() } },
        { upsert: true },
      );
    }

    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v1/domain_blocks ───────────────────────────────────────────

router.delete("/api/v1/domain_blocks", tokenRequired, scopeRequired("write", "write:blocks"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const domain = req.body.domain?.trim();

    if (domain && collections.ap_blocked_servers) {
      await collections.ap_blocked_servers.deleteOne({ hostname: domain });
    }

    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── Endorsements ───────────────────────────────────────────────────────────

router.get("/api/v1/endorsements", (req, res) => {
  res.json([]);
});

// NOTE: the /accounts/:id/statuses, /accounts/:id/followers and
// /accounts/:id/following stubs were REMOVED — accounts.js registers real
// implementations for all three, and accountsRouter mounts before stubsRouter
// in router.js, so the stubs here were unreachable dead code (and a debugging
// trap: the always-[] followers/following stubs looked like the live bug).
// A duplicate route added in this file will be silently shadowed the same way.

export default router;
