/**
 * Account endpoints for Mastodon Client API.
 *
 * Phase 1: verify_credentials, preferences, account lookup
 * Phase 2: relationships, follow/unfollow, account statuses
 */
import {
  blockAccount,
  getAllMutedRows,
  getBlockedAccounts,
  getBlockedServerRows,
  muteAccount,
  unblockAccount,
  unmuteAccount,
} from "../../core/moderation.js";
import { count, list } from "../../core/collections-io.js";
import { searchRelationships } from "../../core/moderation.js";
import { loadInteractionState } from "../../core/interactions.js";
import { getTimeline } from "../../core/timeline.js";
import {
  countAuthorPosts,
  getActorStats,
  getFollowers,
  getFollowing,
  findAuthorByHandle,
  findFollowerByHandle,
  findFollowingByHandle,
  getKnownAuthors,
  getProfile,
  getRelationshipsByUrls,
  updateProfile,
} from "../../core/profile.js";
import express from "express";
import { serializeCredentialAccount, serializeAccount } from "../entities/account.js";
import { serializeStatus } from "../entities/status.js";
import { accountId, remoteActorId, isLocalAccountId } from "../helpers/id-mapping.js";
import { parseLimit, setCursorHeaders } from "../helpers/pagination.js";
import { resolveRemoteAccount, fetchRemoteCollectionMemberUrls } from "../helpers/resolve-account.js";
import { getActorUrlFromId } from "../helpers/account-cache.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/accounts/verify_credentials ─────────────────────────────────

router.get("/api/v1/accounts/verify_credentials", tokenRequired, scopeRequired("read", "read:accounts"), async (req, res, next) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    const profile = await getProfile(collections);
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Get counts
    let counts = {};
    try {
      const [statuses, followers, following] = await Promise.all([
        count(collections.ap_timeline, {
          "author.url": profile.url,
        }),
        count(collections.ap_followers),
        count(collections.ap_following),
      ]);
      counts = { statuses, followers, following };
    } catch {
      counts = { statuses: 0, followers: 0, following: 0 };
    }

    const account = serializeCredentialAccount(profile, {
      baseUrl,
      handle,
      counts,
    });

    res.json(account);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/preferences ─────────────────────────────────────────────────

router.get("/api/v1/preferences", tokenRequired, scopeRequired("read", "read:accounts"), (req, res) => {
  const apSettings = req.app.locals.apSettings;
  res.json({
    "posting:default:visibility": apSettings?.defaultVisibility || "public",
    "posting:default:sensitive": false,
    "posting:default:language": apSettings?.defaultLanguage || "en",
    "reading:expand:media": "default",
    "reading:expand:spoilers": false,
  });
});

// ─── GET /api/v1/accounts/lookup ─────────────────────────────────────────────

router.get("/api/v1/accounts/lookup", async (req, res, next) => {
  try {
    const { acct } = req.query;
    if (!acct) {
      return res.status(400).json({ error: "Missing acct parameter" });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    // Check if looking up local account
    const bareAcct = acct.startsWith("@") ? acct.slice(1) : acct;
    const localDomain = req.get("host");

    if (
      bareAcct === handle ||
      bareAcct === `${handle}@${localDomain}`
    ) {
      const profile = await getProfile(collections);
      if (profile) {
        return res.json(
          serializeAccount(profile, { baseUrl, isLocal: true, handle }),
        );
      }
    }

    // Check followers for known remote actors
    const follower = await findFollowerByHandle(collections, bareAcct);
    if (follower) {
      return res.json(
        serializeAccount(
          { name: follower.name, url: follower.actorUrl, photo: follower.avatar, handle: follower.handle, bannerUrl: follower.banner || "" },
          { baseUrl },
        ),
      );
    }

    // Check following
    const following = await findFollowingByHandle(collections, bareAcct);
    if (following) {
      return res.json(
        serializeAccount(
          { name: following.name, url: following.actorUrl, photo: following.avatar, handle: following.handle },
          { baseUrl },
        ),
      );
    }

    // Check timeline authors (people whose posts are in our timeline)
    const timelineAuthor = await findAuthorByHandle(collections, bareAcct);
    if (timelineAuthor) {
      return res.json(serializeAccount(timelineAuthor, { baseUrl }));
    }

    // Resolve remotely via federation (WebFinger + actor fetch)
    const resolved = await resolveRemoteAccount(bareAcct, pluginOptions, baseUrl);
    if (resolved) {
      return res.json(resolved);
    }

    return res.status(404).json({ error: "Record not found" });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/search ────────────────────────────────────────────
// Used by clients for @mention autocomplete in compose box.

router.get("/api/v1/accounts/search", tokenRequired, scopeRequired("read", "read:accounts"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const query = req.query.q?.trim();
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 10, 40);

    if (!query) {
      return res.json([]);
    }

    // Escape regex special characters
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    const results = new Map(); // dedupe by URL

    // Search followers
    if (collections.ap_followers) {
      const followers = await searchRelationships(collections, query, { limit });
      for (const f of followers) results.set(f.actorUrl, f);
    }

    // Search following
    if (results.size < limit && collections.ap_following) {
      const following = [];
      for (const f of following) results.set(f.actorUrl, f);
    }

    const { serializeAccount } = await import("../entities/account.js");
    const accounts = [...results.values()]
      .slice(0, limit)
      .map((actor) =>
        serializeAccount(actor, { baseUrl, isLocal: false }),
      );

    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/relationships ──────────────────────────────────────
// MUST be before /accounts/:id to prevent Express matching "relationships" as :id

router.get("/api/v1/accounts/relationships", tokenRequired, scopeRequired("read", "read:follows"), async (req, res, next) => {
  try {
    let ids = req.query["id[]"] || req.query.id || [];
    if (!Array.isArray(ids)) ids = [ids];

    if (ids.length === 0) {
      return res.json([]);
    }

    const collections = req.app.locals.mastodonCollections;

    const [followers, following, blocked, muted, blockedServers] = await Promise.all([
      getFollowers(collections),
      getFollowing(collections),
      getBlockedAccounts(collections),
      getAllMutedRows(collections),
      getBlockedServerRows(collections),
    ]);

    const followerIds = new Set(followers.map((f) => remoteActorId(f.actorUrl)));
    const followingIds = new Set(following.map((f) => remoteActorId(f.actorUrl)));
    const blockedIds = new Set(blocked.map((b) => remoteActorId(b.url)));
    const mutedIds = new Set(muted.filter((m) => m.url).map((m) => remoteActorId(m.url)));

    // Build domain-blocked actor ID set by checking known actors against blocked server hostnames
    const blockedDomains = new Set(blockedServers.map((s) => s.hostname).filter(Boolean));
    const domainBlockedIds = new Set();
    if (blockedDomains.size > 0) {
      const allActors = [...followers, ...following];
      for (const actor of allActors) {
        try {
          const domain = new URL(actor.actorUrl).hostname;
          if (blockedDomains.has(domain)) {
            domainBlockedIds.add(remoteActorId(actor.actorUrl));
          }
        } catch { /* skip invalid URLs */ }
      }
    }

    const relationships = ids.map((id) => ({
      id,
      following: followingIds.has(id),
      showing_reblogs: followingIds.has(id),
      notifying: false,
      languages: [],
      followed_by: followerIds.has(id),
      blocking: blockedIds.has(id),
      blocked_by: false,
      muting: mutedIds.has(id),
      muting_notifications: mutedIds.has(id),
      requested: false,
      requested_by: false,
      domain_blocking: domainBlockedIds.has(id),
      endorsed: false,
      note: "",
    }));

    res.json(relationships);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/familiar_followers ─────────────────────────────────
// MUST be before /accounts/:id

router.get("/api/v1/accounts/familiar_followers", tokenRequired, scopeRequired("read", "read:follows"), (req, res) => {
  let ids = req.query["id[]"] || req.query.id || [];
  if (!Array.isArray(ids)) ids = [ids];
  res.json(ids.map((id) => ({ id, accounts: [] })));
});

// ─── PATCH /api/v1/accounts/update_credentials ──────────────────────────────

router.patch("/api/v1/accounts/update_credentials", tokenRequired, scopeRequired("write", "write:accounts"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const update = {};
    if (req.body.display_name !== undefined) update.name = req.body.display_name;
    if (req.body.note !== undefined) update.summary = req.body.note;
    if (req.body.fields_attributes) {
      update.attachments = Object.values(req.body.fields_attributes).map(
        (f) => ({
          name: f.name,
          value: f.value,
        }),
      );
    }

    if (Object.keys(update).length > 0 && collections.ap_profile) {
      await updateProfile(collections, update);

      // Broadcast Update(Person) to followers so profile changes federate
      if (pluginOptions.broadcastActorUpdate) {
        pluginOptions.broadcastActorUpdate().catch((err) =>
          console.warn(`[Mastodon API] broadcastActorUpdate failed: ${err.message}`),
        );
      }
    }

    // Return updated credential account
    const profile = collections.ap_profile
      ? await getProfile(collections)
      : {};

    const handle = pluginOptions.handle || "user";
    let counts = {};
    try {
      const stats = await getActorStats(collections, profile.url);
      counts = {
        statuses: stats.statusCount,
        followers: stats.followerCount,
        following: stats.followingCount,
      };
    } catch {
      counts = { statuses: 0, followers: 0, following: 0 };
    }

    const { serializeCredentialAccount } = await import(
      "../entities/account.js"
    );
    res.json(serializeCredentialAccount(profile, { baseUrl, handle, counts }));
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/:id ────────────────────────────────────────────────

router.get("/api/v1/accounts/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    // Check if it's the local profile (id = sha256(profile.url) per accountId(),
    // with a legacy _id fallback — see isLocalAccountId)
    const profile = await getProfile(collections);
    if (isLocalAccountId(id, profile)) {
      const [statuses, followers, following] = await Promise.all([
        countAuthorPosts(collections, profile.url),
        count(collections.ap_followers),
        count(collections.ap_following),
      ]);
      const account = serializeAccount(profile, { baseUrl, isLocal: true, handle });
      account.statuses_count = statuses;
      account.followers_count = followers;
      account.following_count = following;
      return res.json(account);
    }

    // Resolve remote actor from followers, following, or timeline
    const { actor, actorUrl } = await resolveActorData(id, collections);
    if (actor) {
      // Try remote resolution to get real counts (followers, following, statuses)
      const remoteAccount = await resolveRemoteAccount(
        actorUrl,
        pluginOptions,
        baseUrl,
      );
      if (remoteAccount) {
        return res.json(remoteAccount);
      }

      // Fallback to local data
      const account = serializeAccount(actor, { baseUrl });
      account.statuses_count = await count(collections.ap_timeline, {
        "author.url": actorUrl,
      });
      return res.json(account);
    }

    return res.status(404).json({ error: "Record not found" });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/:id/statuses ──────────────────────────────────────

router.get("/api/v1/accounts/:id/statuses", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    // Resolve account ID to an author URL
    const actorUrl = await resolveActorUrl(id, collections);
    if (!actorUrl) {
      return res.status(404).json({ error: "Record not found" });
    }

    const { items, before, after } = await getTimeline(collections, {
      // An account's own posts, not a feed — visibility is whatever this actor
      // published, so `home` (everything but direct) is the right predicate.
      feed: "home",
      authorUrl: actorUrl,
      onlyMedia: req.query.only_media === "true",
      excludeReplies: req.query.exclude_replies === "true",
      excludeBoosts: req.query.exclude_reblogs === "true",
      pinnedOnly: req.query.pinned === "true",
      limit: req.query.limit,
      before: req.query.max_id,
      after: req.query.since_id,
      since: req.query.min_id,
    });

    // Load interaction state if authenticated
    let favouritedIds = new Set();
    let rebloggedIds = new Set();
    let bookmarkedIds = new Set();

    if (req.mastodonToken) {
      ({ favouritedIds, rebloggedIds, bookmarkedIds } =
        await loadInteractionState(collections, items));
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

    setCursorHeaders(res, req, { before, after });
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/:id/featured_tags ─────────────────────────────────
// Public on Mastodon. Was an unhandled 501 — Phanpy calls it on every profile
// view and logged a console error each time.

router.get("/api/v1/accounts/:id/featured_tags", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const profile = await getProfile(collections);

    // Only the local account has featured tags; remote accounts → []
    if (!isLocalAccountId(id, profile) || !collections.ap_featured_tags) {
      return res.json([]);
    }

    const publicationUrl = (pluginOptions.publicationUrl || "").replace(/\/$/, "");
    const tags = await list(collections.ap_featured_tags, { filter: {} });
    res.json(tags.map((t) => ({
      id: remoteActorId(`tag:${t.tag}`),
      name: t.tag,
      url: `${publicationUrl}/categories/${encodeURIComponent(t.tag)}`,
      statuses_count: 0,
      last_status_at: null,
    })));
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/:id/followers ─────────────────────────────────────
// NOTE: this and /:id, /:id/statuses, /:id/following are PUBLIC (no
// tokenRequired) to match Mastodon semantics — the same data is already
// public via ActivityPub, and Phanpy's instance-browse view (#/<host>/a/<id>)
// calls them without a token.

router.get("/api/v1/accounts/:id/followers", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);
    const profile = await getProfile(collections);

    // Local account: serve from ap_followers
    if (isLocalAccountId(id, profile)) {
      const followers = await getFollowers(collections);

      return res.json(followers.map((f) =>
        serializeAccount(
          { name: f.name, url: f.actorUrl, photo: f.avatar, handle: f.handle, bannerUrl: f.banner || "" },
          { baseUrl },
        ),
      ));
    }

    // Remote account: fetch the first page of their AP followers collection.
    // Many servers hide it — the helper returns [] gracefully.
    const actorUrl = await resolveActorUrl(id, collections);
    if (!actorUrl) return res.json([]);

    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const memberUrls = await fetchRemoteCollectionMemberUrls(actorUrl, "followers", pluginOptions, limit);
    res.json(await serializeMemberUrls(memberUrls, collections, baseUrl));
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/:id/following ─────────────────────────────────────

router.get("/api/v1/accounts/:id/following", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);
    const profile = await getProfile(collections);

    // Local account: serve from ap_following
    if (isLocalAccountId(id, profile)) {
      const following = await getFollowing(collections);

      return res.json(following.map((f) =>
        serializeAccount(
          { name: f.name, url: f.actorUrl, photo: f.avatar, handle: f.handle, bannerUrl: f.banner || "" },
          { baseUrl },
        ),
      ));
    }

    // Remote account: fetch the first page of their AP following collection.
    const actorUrl = await resolveActorUrl(id, collections);
    if (!actorUrl) return res.json([]);

    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const memberUrls = await fetchRemoteCollectionMemberUrls(actorUrl, "following", pluginOptions, limit);
    res.json(await serializeMemberUrls(memberUrls, collections, baseUrl));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/follow ───────────────────────────────────────

router.post("/api/v1/accounts/:id/follow", tokenRequired, scopeRequired("write", "write:follows", "follow"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};

    // Resolve the account ID to an actor URL
    const actorUrl = await resolveActorUrl(id, collections);
    if (!actorUrl) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Use the plugin's followActor method
    if (pluginOptions.followActor) {
      const result = await pluginOptions.followActor(actorUrl);
      if (!result.ok) {
        return res.status(422).json({ error: result.error || "Follow failed" });
      }
    }

    // Return relationship
    const followingIds = new Set();
    const following = await getFollowing(collections);
    for (const f of following) {
      followingIds.add(remoteActorId(f.actorUrl));
    }

    const followerIds = new Set();
    const followers = await getFollowers(collections);
    for (const f of followers) {
      followerIds.add(remoteActorId(f.actorUrl));
    }

    res.json({
      id,
      following: true,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: followerIds.has(id),
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/unfollow ─────────────────────────────────────

router.post("/api/v1/accounts/:id/unfollow", tokenRequired, scopeRequired("write", "write:follows", "follow"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};

    const actorUrl = await resolveActorUrl(id, collections);
    if (!actorUrl) {
      return res.status(404).json({ error: "Record not found" });
    }

    if (pluginOptions.unfollowActor) {
      const result = await pluginOptions.unfollowActor(actorUrl);
      if (!result.ok) {
        return res.status(422).json({ error: result.error || "Unfollow failed" });
      }
    }

    const followerIds = new Set();
    const followers = await getFollowers(collections);
    for (const f of followers) {
      followerIds.add(remoteActorId(f.actorUrl));
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: followerIds.has(id),
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/mute ────────────────────────────────────────

router.post("/api/v1/accounts/:id/mute", tokenRequired, scopeRequired("write", "write:mutes", "follow"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_muted) {
      await muteAccount(collections, actorUrl);
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: true,
      muting_notifications: true,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/unmute ───────────────────────────────────────

router.post("/api/v1/accounts/:id/unmute", tokenRequired, scopeRequired("write", "write:mutes", "follow"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_muted) {
      await unmuteAccount(collections, actorUrl);
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/block ───────────────────────────────────────

router.post("/api/v1/accounts/:id/block", tokenRequired, scopeRequired("write", "write:blocks", "follow"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_blocked) {
      await blockAccount(collections, actorUrl);
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: true,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/unblock ──────────────────────────────────────

router.post("/api/v1/accounts/:id/unblock", tokenRequired, scopeRequired("write", "write:blocks", "follow"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_blocked) {
      await unblockAccount(collections, actorUrl);
    }

    res.json({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: [],
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Serialize a list of member actor URLs (from a remote followers/following
 * collection) into Mastodon Account entities, enriching from locally-known
 * ap_followers/ap_following docs where available so mutual accounts get their
 * real name/avatar instead of a URL-derived placeholder.
 */
async function serializeMemberUrls(memberUrls, collections, baseUrl) {
  if (memberUrls.length === 0) return [];

  const known = new Map();
  {
    const found = await getRelationshipsByUrls(collections, memberUrls);
    for (const [url, d] of found) {
      if (!known.has(url)) known.set(url, d);
    }
  }

  return memberUrls
    .map((url) => {
      const d = known.get(url);
      return serializeAccount(
        d
          ? { name: d.name, url: d.actorUrl, photo: d.avatar, handle: d.handle }
          : { url },
        { baseUrl },
      );
    })
    .filter(Boolean);
}

/**
 * Resolve an account ID back to an actor URL by scanning followers/following.
 */
async function resolveActorUrl(id, collections) {
  // Check if it's the local profile
  const profile = await getProfile(collections);
  if (isLocalAccountId(id, profile)) {
    return profile.url;
  }

  // Check account cache reverse lookup (populated by resolveRemoteAccount)
  const cachedUrl = getActorUrlFromId(id);
  if (cachedUrl) return cachedUrl;

  // Check followers
  const followers = await getFollowers(collections);
  for (const f of followers) {
    if (remoteActorId(f.actorUrl) === id) {
      return f.actorUrl;
    }
  }

  // Check following
  const following = await getFollowing(collections);
  for (const f of following) {
    if (remoteActorId(f.actorUrl) === id) {
      return f.actorUrl;
    }
  }

  // Check timeline authors
  const timelineItems = await getKnownAuthors(collections);

  const seenUrls = new Set();
  for (const item of timelineItems) {
    const authorUrl = item.author?.url;
    if (!authorUrl || seenUrls.has(authorUrl)) continue;
    seenUrls.add(authorUrl);
    if (remoteActorId(authorUrl) === id) {
      return authorUrl;
    }
  }

  return null;
}

/**
 * Resolve an account ID to both actor data and URL.
 * Returns { actor, actorUrl } or { actor: null, actorUrl: null }.
 */
async function resolveActorData(id, collections) {
  // Check the account-cache reverse map first (populated by resolveRemoteAccount
  // via lookup/search). Without this, an account with NO local DB trace (e.g.
  // its only timeline item was pruned by retention) 404s on by-id fetch even
  // right after a successful /accounts/lookup for the same account.
  const cachedUrl = getActorUrlFromId(id);
  if (cachedUrl) {
    return { actor: { url: cachedUrl }, actorUrl: cachedUrl };
  }

  // Check followers — pass through all stored fields for richer serialization
  const followers = await getFollowers(collections);
  for (const f of followers) {
    if (remoteActorId(f.actorUrl) === id) {
      return {
        actor: {
          name: f.name,
          url: f.actorUrl,
          photo: f.avatar,
          handle: f.handle,
          bannerUrl: f.banner || "",
        },
        actorUrl: f.actorUrl,
      };
    }
  }

  // Check following — pass through all stored fields
  const following = await getFollowing(collections);
  for (const f of following) {
    if (remoteActorId(f.actorUrl) === id) {
      return {
        actor: {
          name: f.name,
          url: f.actorUrl,
          photo: f.avatar,
          handle: f.handle,
          bannerUrl: f.banner || "",
        },
        actorUrl: f.actorUrl,
      };
    }
  }

  // Check timeline authors
  const timelineItems = await getKnownAuthors(collections);

  const seenUrls = new Set();
  for (const item of timelineItems) {
    const authorUrl = item.author?.url;
    if (!authorUrl || seenUrls.has(authorUrl)) continue;
    seenUrls.add(authorUrl);
    if (remoteActorId(authorUrl) === id) {
      return { actor: item.author, actorUrl: authorUrl };
    }
  }

  return { actor: null, actorUrl: null };
}

export default router;
