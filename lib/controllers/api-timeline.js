/**
 * JSON API timeline endpoints for the reader's infinite scroll.
 *
 * ADAPTER ONLY. Query construction, ordering, visibility and read state live in
 * lib/core/timeline.js — this file parses the reader's parameters, calls core
 * once, and renders HTML cards. No business rules, no database queries
 * (plan §3; CI rule 5.2 lands in Stage 5).
 *
 * Behaviour changes from the port, all ratified:
 *   DD-1  ordering is arrival (`receivedAt`), not `published`. A post that
 *         federates in three days late now appears at the top rather than
 *         buried where nobody would see it.
 *   DD-3  read state is shared with the Mastodon lane via `readAt`.
 *   DD-4  followers-only posts now appear here, matching the phone.
 */

import { getToken, validateToken } from "../csrf.js";
import {
  countNewer,
  getTimeline,
  markRead,
} from "../core/timeline.js";
import {
  postProcessItems,
  applyTabFilter,
  loadModerationData,
  renderItemCards,
} from "../item-processing.js";

/** Reader page size. Adapter policy — core takes it as a parameter (F-2). */
const READER_PAGE_SIZE = 20;

/**
 * Translate a reader tab into core filter options.
 *
 * `mentions` and `replies` have no core-level predicate; they are narrowed
 * afterwards by applyTabFilter, which inspects rendered content.
 */
function tabOptions(tab, tag) {
  if (tag) return { tag };

  switch (tab) {
    case "notes":
      return { type: "note", excludeReplies: true };
    case "articles":
      return { type: "article" };
    case "boosts":
      return { type: "boost" };
    default:
      return {};
  }
}

export function apiTimelineController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      const tab = request.query.tab || "notes";
      const tag =
        typeof request.query.tag === "string" ? request.query.tag.trim() : "";

      const result = await getTimeline(collections, {
        feed: "home",
        limit: READER_PAGE_SIZE,
        before: request.query.before,
        unreadOnly: request.query.unread === "1",
        ...tabOptions(tab, tag),
      });

      // Tabs core cannot express (mentions, replies) are narrowed here.
      const tabFiltered = tag ? result.items : applyTabFilter(result.items, tab);

      const modCollections = {
        ap_muted: application?.collections?.get("ap_muted"),
        ap_blocked: application?.collections?.get("ap_blocked"),
        ap_profile: application?.collections?.get("ap_profile"),
      };
      const moderation = await loadModerationData(modCollections);

      const { items, interactionMap } = await postProcessItems(tabFiltered, {
        moderation,
        interactionsCol: application?.collections?.get("ap_interactions"),
      });

      const csrfToken = getToken(request.session);
      const html = await renderItemCards(items, request, {
        ...response.locals,
        mountPath,
        csrfToken,
        interactionMap,
      });

      response.json({
        html,
        before: result.before,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * GET /admin/reader/api/timeline/count-new — count items newer than a cursor.
 *
 * `after` is now an opaque cursor from core, not a date string (DD-2).
 */
export function countNewController() {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      const tab = request.query.tab || "notes";

      const count = await countNewer(collections, request.query.after, {
        feed: "home",
        ...tabOptions(tab, ""),
      });

      response.json({ count });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/api/timeline/mark-read — mark items read by UID.
 *
 * DD-3: writes the shared `readAt`, so marking read here also marks read on
 * the phone.
 */
export function markReadController() {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response
          .status(403)
          .json({ success: false, error: "Invalid CSRF token" });
      }

      const { uids } = request.body;
      if (!Array.isArray(uids) || uids.length === 0) {
        return response
          .status(400)
          .json({ success: false, error: "Missing uids array" });
      }

      // Cap batch size to prevent abuse
      const batch = uids.slice(0, 100).filter((uid) => typeof uid === "string");

      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      const updated = await markRead(collections, batch);
      response.json({ success: true, updated });
    } catch (error) {
      next(error);
    }
  };
}
