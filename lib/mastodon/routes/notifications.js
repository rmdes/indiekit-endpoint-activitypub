/**
 * Notification endpoints for Mastodon Client API.
 *
 * GET /api/v1/notifications — list notifications with pagination
 * GET /api/v1/notifications/:id — single notification
 * POST /api/v1/notifications/clear — clear all notifications
 * POST /api/v1/notifications/:id/dismiss — dismiss single notification
 */
import express from "express";
import { serializeNotification } from "../entities/notification.js";
import { setCursorHeaders } from "../helpers/pagination.js";
import {
  getNotifications as coreGetNotifications,
  markRead as coreMarkRead,
  getNotification as coreGetNotification,
} from "../../core/notifications.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

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

router.get("/api/v1/notifications", tokenRequired, scopeRequired("read", "read:notifications"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    // DD-3: "unread" is now the shared `readAt`, not this lane's private
    // `dismissed` flag. A notification marked read in the desktop reader no
    // longer reappears here, and vice versa — that is AP-D2 closed.
    const { items, before, after } = await coreGetNotifications(collections, {
      limit: req.query.limit,
      before: req.query.max_id,
      after: req.query.since_id,
      since: req.query.min_id,
      unreadOnly: true,
      types: resolveInternalTypes(
        normalizeArray(req.query["types[]"] || req.query.types),
      ),
      excludeTypes: resolveInternalTypes(
        normalizeArray(req.query["exclude_types[]"] || req.query.exclude_types),
      ),
    });

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

    setCursorHeaders(res, req, { before, after });

    res.json(notifications);
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/notifications/:id ──────────────────────────────────────────

router.get("/api/v1/notifications/:id", tokenRequired, scopeRequired("read", "read:notifications"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const notif = await coreGetNotification(collections, req.params.id);
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

router.post("/api/v1/notifications/clear", tokenRequired, scopeRequired("write", "write:notifications"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    // Mark read, never delete: ap_notifications is shared with the reader, and
    // a hard delete here would destroy history on one client tap. Core writes
    // the shared `readAt` (plus the legacy fields during the M-1a window).
    await coreMarkRead(collections, {});
    res.json({});
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v1/notifications/:id/dismiss ─────────────────────────────────

router.post("/api/v1/notifications/:id/dismiss", tokenRequired, scopeRequired("write", "write:notifications"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;


    // Mark read (shared store — see /clear). Never hard-delete here.
    await coreMarkRead(collections, { ids: [req.params.id] });
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
