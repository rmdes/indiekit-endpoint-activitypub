/**
 * Federation Management controllers — admin page for inspecting and managing
 * the relationship between local content and the fediverse.
 */

import Redis from "ioredis";
import { getToken, validateToken } from "../csrf.js";
import { jf2ToActivityStreams } from "../jf2-to-as2.js";
import { lookupWithSecurity } from "../lookup-helpers.js";

const PAGE_SIZE = 20;

const AP_COLLECTIONS = [
  "ap_followers",
  "ap_following",
  "ap_activities",
  "ap_keys",
  "ap_kv",
  "ap_profile",
  "ap_featured",
  "ap_featured_tags",
  "ap_timeline",
  "ap_notifications",
  "ap_muted",
  "ap_blocked",
  "ap_interactions",
  "ap_followed_tags",
  "ap_messages",
  "ap_explore_tabs",
  "ap_reports",
];

/**
 * GET /admin/federation — main federation management page.
 */
export function federationMgmtController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = application?.collections;

      const redisUrl = plugin.options.redisUrl || "";

      // Parallel: collection stats + posts + recent activities + moderation data
      const pluginCollections = plugin._collections || {};
      const [collectionStats, postsResult, recentActivities, blockedServers, blockedAccounts, mutedAccounts] =
        await Promise.all([
          getCollectionStats(collections, { redisUrl }),
          getPaginatedPosts(collections, request.query.page),
          getRecentActivities(collections),
          pluginCollections.ap_blocked_servers?.find({}).sort({ blockedAt: -1 }).toArray() || [],
          pluginCollections.ap_blocked?.find({}).sort({ blockedAt: -1 }).toArray() || [],
          pluginCollections.ap_muted?.find({}).sort({ mutedAt: -1 }).toArray() || [],
        ]);

      const csrfToken = getToken(request.session);
      const actorUrl = plugin._getActorUrl?.() || "";

      response.render("activitypub-federation-mgmt", {
        title: response.locals.__("activitypub.federationMgmt.title"),
        parent: {
          href: mountPath,
          text: response.locals.__("activitypub.title"),
        },
        collectionStats,
        posts: postsResult.posts,
        cursor: postsResult.cursor,
        recentActivities,
        blockedServers: blockedServers || [],
        blockedAccounts: blockedAccounts || [],
        mutedAccounts: mutedAccounts || [],
        csrfToken,
        mountPath,
        publicationUrl: plugin._publicationUrl,
        actorUrl,
        debugDashboardEnabled: plugin.options.debugDashboard,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/federation/rebroadcast — re-send a Create activity for a post.
 */
export function rebroadcastController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response
          .status(403)
          .json({ success: false, error: "Invalid CSRF token" });
      }

      const { url } = request.body;
      if (!url) {
        return response
          .status(400)
          .json({ success: false, error: "Missing post URL" });
      }

      if (!plugin._federation) {
        return response
          .status(503)
          .json({ success: false, error: "Federation not initialized" });
      }

      const { application } = request.app.locals;
      const postsCol = application?.collections?.get("posts");
      if (!postsCol) {
        return response
          .status(500)
          .json({ success: false, error: "Posts collection not available" });
      }

      const post = await postsCol.findOne({ "properties.url": url });
      if (!post) {
        return response
          .status(404)
          .json({ success: false, error: "Post not found" });
      }

      // Reuse the full syndication pipeline (mention resolution, visibility,
      // addressing, delivery) via the syndicator
      await plugin.syndicator.syndicate(post.properties);

      return response.json({ success: true, url });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * GET /admin/federation/ap-json — view ActivityStreams JSON for a post.
 */
export function viewApJsonController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { url } = request.query;
      if (!url) {
        return response
          .status(400)
          .json({ error: "Missing url query parameter" });
      }

      const { application } = request.app.locals;
      const postsCol = application?.collections?.get("posts");
      if (!postsCol) {
        return response
          .status(500)
          .json({ error: "Posts collection not available" });
      }

      const post = await postsCol.findOne({ "properties.url": url });
      if (!post) {
        return response.status(404).json({ error: "Post not found" });
      }

      const actorUrl = plugin._getActorUrl?.() || "";
      const as2 = jf2ToActivityStreams(
        post.properties,
        actorUrl,
        plugin._publicationUrl,
      );

      return response.json(as2);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/federation/broadcast-actor — broadcast an Update(Person)
 * activity to all followers via Fedify.
 */
export function broadcastActorUpdateController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response
          .status(403)
          .json({ success: false, error: "Invalid CSRF token" });
      }

      if (!plugin._federation) {
        return response
          .status(503)
          .json({ success: false, error: "Federation not initialized" });
      }

      await plugin.broadcastActorUpdate();

      return response.json({ success: true });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * GET /admin/federation/lookup — resolve a URL or @user@domain handle
 * via Fedify's lookupObject (authenticated document loader).
 */
export function lookupObjectController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const query = (request.query.q || "").trim();
      if (!query) {
        return response
          .status(400)
          .json({ error: "Missing q query parameter" });
      }

      if (!plugin._federation) {
        return response
          .status(503)
          .json({ error: "Federation not initialized" });
      }

      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });

      const object = await lookupWithSecurity(ctx,query, { documentLoader });

      if (!object) {
        return response
          .status(404)
          .json({ error: "Could not resolve object" });
      }

      const jsonLd = await object.toJsonLd();
      return response.json(jsonLd);
    } catch (error) {
      return response
        .status(500)
        .json({ error: error.message || "Lookup failed" });
    }
  };
}

// --- Helpers ---

async function getCollectionStats(collections, { redisUrl = "" } = {}) {
  if (!collections) return [];

  const stats = await Promise.all(
    AP_COLLECTIONS.map(async (name) => {
      // When Redis handles KV, count fedify::* keys from Redis instead
      if (name === "ap_kv" && redisUrl) {
        const count = await countRedisKvKeys(redisUrl);
        return { name: "ap_kv (redis)", count };
      }
      const col = collections.get(name);
      const count = col ? await col.countDocuments() : 0;
      return { name, count };
    }),
  );

  return stats;
}

/**
 * Count Fedify KV keys in Redis (prefix: "fedify::").
 * Uses SCAN to avoid blocking on large key spaces.
 */
async function countRedisKvKeys(redisUrl) {
  let client;
  try {
    client = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 3000 });
    await client.connect();
    let count = 0;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        "MATCH",
        "fedify::*",
        "COUNT",
        500,
      );
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== "0");
    return count;
  } catch {
    return 0;
  } finally {
    client?.disconnect();
  }
}

async function getPaginatedPosts(collections, pageParam) {
  const postsCol = collections?.get("posts");
  if (!postsCol) return { posts: [], cursor: null };

  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
  const totalCount = await postsCol.countDocuments();
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const rawPosts = await postsCol
    .find()
    .sort({ "properties.published": -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .toArray();

  const posts = rawPosts.map((post) => {
    const props = post.properties || {};
    const url = props.url || "";
    const content = props.content?.text || props.content?.html || "";
    const name =
      props.name || (content ? content.slice(0, 80) : url.split("/").pop());
    return {
      url,
      name,
      postType: props["post-type"] || "unknown",
      published: props.published || null,
      syndication: props.syndication || [],
      deleted: props.deleted || false,
    };
  });

  const cursor = buildCursor(page, totalPages, "admin/federation");

  return { posts, cursor };
}

async function getRecentActivities(collections) {
  const col = collections?.get("ap_activities");
  if (!col) return [];

  return col.find().sort({ receivedAt: -1 }).limit(5).toArray();
}

function buildCursor(page, totalPages, basePath) {
  if (totalPages <= 1) return null;

  return {
    previous:
      page > 1 ? { href: `${basePath}?page=${page - 1}` } : undefined,
    next:
      page < totalPages
        ? { href: `${basePath}?page=${page + 1}` }
        : undefined,
  };
}
