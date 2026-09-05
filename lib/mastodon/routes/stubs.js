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
import { getInteractionsByType } from "../../core/interactions.js";
import { getItemsByUrls } from "../../core/timeline.js";
import express from "express";
import { serializeStatus } from "../entities/status.js";
import { serializeAccount } from "../entities/account.js";
import { parseLimit, setCursorHeaders } from "../helpers/pagination.js";
import {
  followTag,
  getFollowedTags,
  isTagFollowed,
  normaliseTag,
  unfollowTag,
} from "../../core/tags.js";
import { getMarkers, setMarkers } from "../../core/markers.js";
import {
  blockServer,
  getBlockedAccounts,
  getBlockedServers,
  unblockServer,
} from "../../core/moderation.js";
import { getPendingFollows } from "../../core/follow-requests.js";
import { getMutedAccounts } from "../../core/moderation.js";
import { getConversations } from "../../core/messages.js";
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

    res.json(await getMarkers(collections, timelines));
  } catch (error) {
    next(error);
  }
});

router.post("/api/v1/markers", tokenRequired, scopeRequired("write", "write:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;

    res.json(
      await setMarkers(collections, {
        home: req.body.home,
        notifications: req.body.notifications,
      }),
    );
  } catch (error) {
    next(error);
  }
});

// ─── Follow requests ────────────────────────────────────────────────────────

router.get("/api/v1/follow_requests", tokenRequired, scopeRequired("read", "read:follows"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const pending = await getPendingFollows(collections);
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
    const blocked = await getBlockedAccounts(collections);
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

    const { items: interactions, before, after } = await getInteractionsByType(
      collections,
      "bookmark",
      {
        limit: req.query.limit,
        before: req.query.max_id,
        after: req.query.since_id,
        since: req.query.min_id,
      },
    );

    // Batch-fetch the actual timeline items
    const objectUrls = interactions.map((i) => i.objectUrl).filter(Boolean);
    if (!objectUrls.length) {
      return res.json([]);
    }

    const itemMap = await getItemsByUrls(collections, objectUrls);

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

    setCursorHeaders(res, req, { before, after });
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

    const { items: interactions, before, after } = await getInteractionsByType(
      collections,
      "like",
      {
        limit: req.query.limit,
        before: req.query.max_id,
        after: req.query.since_id,
        since: req.query.min_id,
      },
    );

    const objectUrls = interactions.map((i) => i.objectUrl).filter(Boolean);
    if (!objectUrls.length) {
      return res.json([]);
    }

    const itemMap = await getItemsByUrls(collections, objectUrls);

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

    setCursorHeaders(res, req, { before, after });
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
    const tags = await getFollowedTags(collections);

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
  const tag = normaliseTag(req.params.id);
  const following = await isTagFollowed(collections, tag);

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
  const tag = await followTag(collections, req.params.id);

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
  const tag = await unfollowTag(collections, req.params.id);

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
//
// AP-D6': previously [], while the reader had a full DM UI over the same
// ap_messages collection. Both now read core/messages.js.

router.get("/api/v1/conversations", tokenRequired, scopeRequired("read", "read:statuses"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const conversations = await getConversations(collections, {
      limit: parseLimit(req.query.limit),
    });

    res.json(
      conversations.map((c) => {
        const account = serializeAccount(
          {
            url: c.actorUrl,
            name: c.actorName,
            handle: c.actorHandle,
            photo: c.actorPhoto,
          },
          { baseUrl },
        );

        // A DM is stored in ap_messages, not ap_timeline, so it is shaped for
        // the reader rather than for serializeStatus. Build the minimum
        // Mastodon Status a client needs to render a conversation preview.
        const message = c.lastMessage || {};
        const lastStatus = {
          id: message._id ? message._id.toString() : c.conversationId,
          uri: message.uid || "",
          url: message.uid || "",
          created_at: message.published || new Date().toISOString(),
          content: message.content?.html || message.content?.text || "",
          visibility: "direct",
          sensitive: false,
          spoiler_text: "",
          account,
          media_attachments: [],
          mentions: [],
          tags: [],
          emojis: [],
          reblogs_count: 0,
          favourites_count: 0,
          replies_count: 0,
          favourited: false,
          reblogged: false,
          bookmarked: false,
          in_reply_to_id: null,
          in_reply_to_account_id: null,
          reblog: null,
          poll: null,
          card: null,
          language: null,
        };

        return {
          id: c.conversationId,
          unread: c.unreadCount > 0,
          accounts: account ? [account] : [],
          last_status: lastStatus,
        };
      }),
    );
  } catch (error) {
    next(error);
  }
});

// ─── Domain blocks ──────────────────────────────────────────────────────────

router.get("/api/v1/domain_blocks", async (req, res) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    res.json(await getBlockedServers(collections));
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

    await blockServer(collections, domain);

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

    if (domain) await unblockServer(collections, domain);

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
