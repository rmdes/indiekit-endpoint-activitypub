/**
 * Account endpoints for Mastodon Client API.
 *
 * Phase 1: verify_credentials, preferences, account lookup
 * Phase 2: relationships, follow/unfollow, account statuses
 */
import express from "express";
import { serializeCredentialAccount, serializeAccount } from "../entities/account.js";
import { serializeStatus } from "../entities/status.js";
import { accountId, remoteActorId } from "../helpers/id-mapping.js";
import { buildPaginationQuery, parseLimit, setPaginationHeaders } from "../helpers/pagination.js";
import { resolveRemoteAccount } from "../helpers/resolve-account.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v1/accounts/verify_credentials ─────────────────────────────────

router.get("/api/v1/accounts/verify_credentials", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    const profile = await collections.ap_profile.findOne({});
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Get counts
    let counts = {};
    try {
      const [statuses, followers, following] = await Promise.all([
        collections.ap_timeline.countDocuments({
          "author.url": profile.url,
        }),
        collections.ap_followers.countDocuments({}),
        collections.ap_following.countDocuments({}),
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

router.get("/api/v1/preferences", (req, res) => {
  res.json({
    "posting:default:visibility": "public",
    "posting:default:sensitive": false,
    "posting:default:language": "en",
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
      const profile = await collections.ap_profile.findOne({});
      if (profile) {
        return res.json(
          serializeAccount(profile, { baseUrl, isLocal: true, handle }),
        );
      }
    }

    // Check followers for known remote actors
    const follower = await collections.ap_followers.findOne({
      $or: [
        { handle: `@${bareAcct}` },
        { handle: bareAcct },
      ],
    });
    if (follower) {
      return res.json(
        serializeAccount(
          { name: follower.name, url: follower.actorUrl, photo: follower.avatar, handle: follower.handle, bannerUrl: follower.banner || "" },
          { baseUrl },
        ),
      );
    }

    // Check following
    const following = await collections.ap_following.findOne({
      $or: [
        { handle: `@${bareAcct}` },
        { handle: bareAcct },
      ],
    });
    if (following) {
      return res.json(
        serializeAccount(
          { name: following.name, url: following.actorUrl, photo: following.avatar, handle: following.handle },
          { baseUrl },
        ),
      );
    }

    // Check timeline authors (people whose posts are in our timeline)
    const timelineAuthor = await collections.ap_timeline.findOne({
      "author.handle": { $in: [`@${bareAcct}`, bareAcct] },
    });
    if (timelineAuthor?.author) {
      return res.json(
        serializeAccount(timelineAuthor.author, { baseUrl }),
      );
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

// ─── GET /api/v1/accounts/relationships ──────────────────────────────────────
// MUST be before /accounts/:id to prevent Express matching "relationships" as :id

router.get("/api/v1/accounts/relationships", async (req, res, next) => {
  try {
    let ids = req.query["id[]"] || req.query.id || [];
    if (!Array.isArray(ids)) ids = [ids];

    if (ids.length === 0) {
      return res.json([]);
    }

    const collections = req.app.locals.mastodonCollections;

    const [followers, following, blocked, muted] = await Promise.all([
      collections.ap_followers.find({}).toArray(),
      collections.ap_following.find({}).toArray(),
      collections.ap_blocked.find({}).toArray(),
      collections.ap_muted.find({}).toArray(),
    ]);

    const followerIds = new Set(followers.map((f) => remoteActorId(f.actorUrl)));
    const followingIds = new Set(following.map((f) => remoteActorId(f.actorUrl)));
    const blockedIds = new Set(blocked.map((b) => remoteActorId(b.url)));
    const mutedIds = new Set(muted.filter((m) => m.url).map((m) => remoteActorId(m.url)));

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
      domain_blocking: false,
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

router.get("/api/v1/accounts/familiar_followers", (req, res) => {
  let ids = req.query["id[]"] || req.query.id || [];
  if (!Array.isArray(ids)) ids = [ids];
  res.json(ids.map((id) => ({ id, accounts: [] })));
});

// ─── GET /api/v1/accounts/:id ────────────────────────────────────────────────

router.get("/api/v1/accounts/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const handle = pluginOptions.handle || "user";

    // Check if it's the local profile
    const profile = await collections.ap_profile.findOne({});
    if (profile && profile._id.toString() === id) {
      const [statuses, followers, following] = await Promise.all([
        collections.ap_timeline.countDocuments({ "author.url": profile.url }),
        collections.ap_followers.countDocuments({}),
        collections.ap_following.countDocuments({}),
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
      account.statuses_count = await collections.ap_timeline.countDocuments({
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

    // Build filter for this author's posts
    const baseFilter = {
      "author.url": actorUrl,
      isContext: { $ne: true },
    };

    // Mastodon filters
    if (req.query.only_media === "true") {
      baseFilter.$or = [
        { "photo.0": { $exists: true } },
        { "video.0": { $exists: true } },
        { "audio.0": { $exists: true } },
      ];
    }
    if (req.query.exclude_replies === "true") {
      baseFilter.inReplyTo = { $exists: false };
    }
    if (req.query.exclude_reblogs === "true") {
      baseFilter.type = { $ne: "boost" };
    }
    if (req.query.pinned === "true") {
      baseFilter.pinned = true;
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

    // Load interaction state if authenticated
    let favouritedIds = new Set();
    let rebloggedIds = new Set();
    let bookmarkedIds = new Set();

    if (req.mastodonToken && collections.ap_interactions) {
      const lookupUrls = items.flatMap((i) => [i.uid, i.url].filter(Boolean));
      if (lookupUrls.length > 0) {
        const interactions = await collections.ap_interactions
          .find({ objectUrl: { $in: lookupUrls } })
          .toArray();
        for (const ix of interactions) {
          if (ix.type === "like") favouritedIds.add(ix.objectUrl);
          else if (ix.type === "boost") rebloggedIds.add(ix.objectUrl);
          else if (ix.type === "bookmark") bookmarkedIds.add(ix.objectUrl);
        }
      }
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

    setPaginationHeaders(res, req, items, limit);
    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/accounts/:id/followers ─────────────────────────────────────

router.get("/api/v1/accounts/:id/followers", async (req, res, next) => {
  try {
    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);
    const profile = await collections.ap_profile.findOne({});

    // Only serve followers for the local account
    if (!profile || profile._id.toString() !== id) {
      return res.json([]);
    }

    const followers = await collections.ap_followers
      .find({})
      .limit(limit)
      .toArray();

    const accounts = followers.map((f) =>
      serializeAccount(
        { name: f.name, url: f.actorUrl, photo: f.avatar, handle: f.handle, bannerUrl: f.banner || "" },
        { baseUrl },
      ),
    );

    res.json(accounts);
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
    const profile = await collections.ap_profile.findOne({});

    // Only serve following for the local account
    if (!profile || profile._id.toString() !== id) {
      return res.json([]);
    }

    const following = await collections.ap_following
      .find({})
      .limit(limit)
      .toArray();

    const accounts = following.map((f) =>
      serializeAccount(
        { name: f.name, url: f.actorUrl, photo: f.avatar, handle: f.handle, bannerUrl: f.banner || "" },
        { baseUrl },
      ),
    );

    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/accounts/:id/follow ───────────────────────────────────────

router.post("/api/v1/accounts/:id/follow", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

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
    const following = await collections.ap_following.find({}).toArray();
    for (const f of following) {
      followingIds.add(remoteActorId(f.actorUrl));
    }

    const followerIds = new Set();
    const followers = await collections.ap_followers.find({}).toArray();
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

router.post("/api/v1/accounts/:id/unfollow", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

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
    const followers = await collections.ap_followers.find({}).toArray();
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

router.post("/api/v1/accounts/:id/mute", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_muted) {
      await collections.ap_muted.updateOne(
        { url: actorUrl },
        { $set: { url: actorUrl, createdAt: new Date().toISOString() } },
        { upsert: true },
      );
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

router.post("/api/v1/accounts/:id/unmute", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_muted) {
      await collections.ap_muted.deleteOne({ url: actorUrl });
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

router.post("/api/v1/accounts/:id/block", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_blocked) {
      await collections.ap_blocked.updateOne(
        { url: actorUrl },
        { $set: { url: actorUrl, createdAt: new Date().toISOString() } },
        { upsert: true },
      );
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

router.post("/api/v1/accounts/:id/unblock", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const { id } = req.params;
    const collections = req.app.locals.mastodonCollections;

    const actorUrl = await resolveActorUrl(id, collections);
    if (actorUrl && collections.ap_blocked) {
      await collections.ap_blocked.deleteOne({ url: actorUrl });
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
 * Resolve an account ID back to an actor URL by scanning followers/following.
 */
async function resolveActorUrl(id, collections) {
  // Check if it's the local profile
  const profile = await collections.ap_profile.findOne({});
  if (profile && profile._id.toString() === id) {
    return profile.url;
  }

  // Check followers
  const followers = await collections.ap_followers.find({}).toArray();
  for (const f of followers) {
    if (remoteActorId(f.actorUrl) === id) {
      return f.actorUrl;
    }
  }

  // Check following
  const following = await collections.ap_following.find({}).toArray();
  for (const f of following) {
    if (remoteActorId(f.actorUrl) === id) {
      return f.actorUrl;
    }
  }

  // Check timeline authors
  const timelineItems = await collections.ap_timeline
    .find({ "author.url": { $exists: true } })
    .project({ "author.url": 1 })
    .toArray();

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
  // Check followers — pass through all stored fields for richer serialization
  const followers = await collections.ap_followers.find({}).toArray();
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
  const following = await collections.ap_following.find({}).toArray();
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
  const timelineItems = await collections.ap_timeline
    .find({ "author.url": { $exists: true } })
    .project({ author: 1 })
    .toArray();

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
