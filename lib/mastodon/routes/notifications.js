/**
 * Notification endpoints for Mastodon Client API.
 *
 * GET /api/v1/notifications — list notifications with pagination
 * GET /api/v1/notifications/:id — single notification
 * POST /api/v1/notifications/clear — clear all notifications
 * POST /api/v1/notifications/:id/dismiss — dismiss single notification
 */
import express from "express";
import { ObjectId } from "mongodb";
import { serializeNotification } from "../entities/notification.js";
import { buildPaginationQuery, parseLimit, setPaginationHeaders } from "../helpers/pagination.js";

const router = express.Router(); // eslint-disable-line new-cap

/**
 * Mastodon type -> internal type reverse mapping for filtering.
 */
const REVERSE_TYPE_MAP = {
  favourite: "like",
  reblog: "boost",
  follow: "follow",
  follow_request: "follow_request",
  mention: { $in: ["reply", "mention", "dm"] },
  poll: "poll",
  update: "update",
  "admin.report": "report",
};

// ─── GET /api/v1/notifications ──────────────────────────────────────────────

router.get("/api/v1/notifications", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const limit = parseLimit(req.query.limit);

    // Build base filter
    const baseFilter = {};

    // types[] — include only these Mastodon types
    const includeTypes = normalizeArray(req.query["types[]"] || req.query.types);
    if (includeTypes.length > 0) {
      const internalTypes = resolveInternalTypes(includeTypes);
      if (internalTypes.length > 0) {
        baseFilter.type = { $in: internalTypes };
      }
    }

    // exclude_types[] — exclude these Mastodon types
    const excludeTypes = normalizeArray(req.query["exclude_types[]"] || req.query.exclude_types);
    if (excludeTypes.length > 0) {
      const excludeInternal = resolveInternalTypes(excludeTypes);
      if (excludeInternal.length > 0) {
        baseFilter.type = { ...baseFilter.type, $nin: excludeInternal };
      }
    }

    // Apply cursor pagination
    const { filter, sort, reverse } = buildPaginationQuery(baseFilter, {
      max_id: req.query.max_id,
      min_id: req.query.min_id,
      since_id: req.query.since_id,
    });

    let items = await collections.ap_notifications
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray();

    if (reverse) {
      items.reverse();
    }

    // Batch-fetch referenced timeline items to avoid N+1
    const statusMap = await batchFetchStatuses(collections, items);

    // Serialize notifications
    const notifications = items.map((notif) =>
      serializeNotification(notif, {
        baseUrl,
        statusMap,
        interactionState: {
          favouritedIds: new Set(),
          rebloggedIds: new Set(),
          bookmarkedIds: new Set(),
        },
      }),
    ).filter(Boolean);

    // Set pagination headers
    setPaginationHeaders(res, req, items, limit);

    res.json(notifications);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/notifications/:id ──────────────────────────────────────────

router.get("/api/v1/notifications/:id", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: "Record not found" });
    }

    const notif = await collections.ap_notifications.findOne({ _id: objectId });
    if (!notif) {
      return res.status(404).json({ error: "Record not found" });
    }

    const statusMap = await batchFetchStatuses(collections, [notif]);

    const notification = serializeNotification(notif, {
      baseUrl,
      statusMap,
      interactionState: {
        favouritedIds: new Set(),
        rebloggedIds: new Set(),
        bookmarkedIds: new Set(),
      },
    });

    res.json(notification);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/notifications/clear ───────────────────────────────────────

router.post("/api/v1/notifications/clear", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const collections = req.app.locals.mastodonCollections;
    await collections.ap_notifications.deleteMany({});
    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/notifications/:id/dismiss ─────────────────────────────────

router.post("/api/v1/notifications/:id/dismiss", async (req, res, next) => {
  try {
    const token = req.mastodonToken;
    if (!token) {
      return res.status(401).json({ error: "The access token is invalid" });
    }

    const collections = req.app.locals.mastodonCollections;

    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: "Record not found" });
    }

    await collections.ap_notifications.deleteOne({ _id: objectId });
    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize query param to array (handles string or array).
 */
function normalizeArray(param) {
  if (!param) return [];
  return Array.isArray(param) ? param : [param];
}

/**
 * Convert Mastodon notification types to internal types.
 */
function resolveInternalTypes(mastodonTypes) {
  const result = [];
  for (const t of mastodonTypes) {
    const mapped = REVERSE_TYPE_MAP[t];
    if (mapped) {
      if (mapped.$in) {
        result.push(...mapped.$in);
      } else {
        result.push(mapped);
      }
    }
  }
  return result;
}

/**
 * Batch-fetch timeline items referenced by notifications.
 *
 * @param {object} collections
 * @param {Array} notifications
 * @returns {Promise<Map<string, object>>} Map of targetUrl -> timeline item
 */
async function batchFetchStatuses(collections, notifications) {
  const statusMap = new Map();

  const targetUrls = [
    ...new Set(
      notifications
        .map((n) => n.targetUrl)
        .filter(Boolean),
    ),
  ];

  if (targetUrls.length === 0 || !collections.ap_timeline) {
    return statusMap;
  }

  const items = await collections.ap_timeline
    .find({
      $or: [
        { uid: { $in: targetUrls } },
        { url: { $in: targetUrls } },
      ],
    })
    .toArray();

  for (const item of items) {
    if (item.uid) statusMap.set(item.uid, item);
    if (item.url) statusMap.set(item.url, item);
  }

  return statusMap;
}

export default router;
