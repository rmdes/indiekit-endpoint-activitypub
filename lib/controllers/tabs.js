/**
 * Tab CRUD controller — manages explore tab entries.
 * Stored in the ap_explore_tabs MongoDB collection.
 *
 * Tab types:
 *   - "instance": pinned Mastodon-compatible instance with scope (local/federated)
 *   - "hashtag": aggregated hashtag across all pinned instance tabs
 *
 * IMPORTANT: All insertions must explicitly set all four indexed fields.
 * Missing fields and null are treated differently by MongoDB compound unique indexes.
 * Instance tabs: { type, domain, scope, hashtag: null, order, addedAt }
 * Hashtag tabs:  { type, domain: null, scope: null, hashtag, order, addedAt }
 */

import { deleteTab, getTabs, insertTab, reorderTabs } from "../core/tabs.js";
import { validateToken } from "../csrf.js";
import { validateInstance, validateHashtag } from "./explore-utils.js";

// Re-export for consumers that imported from tabs.js
export { validateHashtag };

/**
 * GET /admin/reader/api/tabs
 * Returns all tab entries sorted by order ascending.
 */
export function listTabsController(_mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_explore_tabs");
      if (!collection) {
        return response.json([]);
      }

      const tabs = await getTabs(
        { ap_explore_tabs: collection },
        {
          projection: {
            _id: 1, type: 1, domain: 1, scope: 1, hashtag: 1, order: 1, addedAt: 1,
          },
        },
      );

      return response.json(tabs);
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * POST /admin/reader/api/tabs
 * Adds a new tab entry.
 * Body (instance tab): { type: "instance", domain, scope }
 * Body (hashtag tab):  { type: "hashtag", hashtag }
 */
export function addTabController(_mountPath) {
  return async (request, response, next) => {
    try {
      // CSRF protection
      if (!validateToken(request)) {
        return response.status(403).json({ error: "Invalid CSRF token" });
      }

      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_explore_tabs");
      if (!collection) {
        return response.status(500).json({ error: "Tab storage unavailable" });
      }

      const { type } = request.body;

      if (type !== "instance" && type !== "hashtag") {
        return response.status(400).json({ error: "Invalid tab type" });
      }

      let tab;

      if (type === "instance") {
        const { domain: rawDomain, scope: rawScope } = request.body;

        // Validate domain (SSRF prevention)
        const domain = validateInstance(rawDomain);
        if (!domain) {
          return response.status(400).json({ error: "Invalid instance domain" });
        }

        // Validate scope
        const scope = rawScope === "federated" ? "federated" : "local";

        // All four indexed fields must be explicitly set
        tab = {
          type: "instance",
          domain,
          scope,
          hashtag: null,       // explicit null — required for unique index
        };
      } else {
        // type === "hashtag"
        const { hashtag: rawHashtag } = request.body;

        const hashtag = validateHashtag(rawHashtag);
        if (!hashtag) {
          return response.status(400).json({
            error:
              "Invalid hashtag. Use alphanumeric characters and underscores only (max 100 chars).",
          });
        }

        // All four indexed fields must be explicitly set
        tab = {
          type: "hashtag",
          domain: null,        // explicit null — required for unique index
          scope: null,         // explicit null — required for unique index
          hashtag,
        };
      }

      // Core assigns `order` and `addedAt`, and reports a duplicate rather
      // than throwing — that is a 409, not a 500.
      const { tab: created, duplicate } = await insertTab(
        { ap_explore_tabs: collection },
        tab,
      );

      if (duplicate) {
        return response.status(409).json({ error: "Tab already exists" });
      }

      return response.status(201).json(created);
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * POST /admin/reader/api/tabs/remove
 * Removes a tab entry and re-compacts order numbers.
 * Body (instance tab): { type: "instance", domain, scope }
 * Body (hashtag tab):  { type: "hashtag", hashtag }
 */
export function removeTabController(_mountPath) {
  return async (request, response, next) => {
    try {
      // CSRF protection
      if (!validateToken(request)) {
        return response.status(403).json({ error: "Invalid CSRF token" });
      }

      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_explore_tabs");
      if (!collection) {
        return response.status(500).json({ error: "Tab storage unavailable" });
      }

      const { type } = request.body;
      let filter;

      if (type === "instance") {
        const domain = validateInstance(request.body.domain);
        if (!domain) {
          return response.status(400).json({ error: "Invalid instance domain" });
        }
        const scope = request.body.scope === "federated" ? "federated" : "local";
        filter = { type: "instance", domain, scope };
      } else if (type === "hashtag") {
        const hashtag = validateHashtag(request.body.hashtag);
        if (!hashtag) {
          return response.status(400).json({ error: "Invalid hashtag" });
        }
        filter = { type: "hashtag", hashtag };
      } else {
        return response.status(400).json({ error: "Invalid tab type" });
      }

      // Core deletes and re-compacts the order numbers in one pass.
      await deleteTab({ ap_explore_tabs: collection }, filter);

      return response.json({ success: true });
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * PATCH /admin/reader/api/tabs/reorder
 * Reorders tabs by accepting an array of tab IDs in the desired order.
 * Body: { tabIds: ["<mongoId1>", "<mongoId2>", ...] }
 * Sets order = index for each tab ID.
 */
export function reorderTabsController(_mountPath) {
  return async (request, response, next) => {
    try {
      // CSRF protection
      if (!validateToken(request)) {
        return response.status(403).json({ error: "Invalid CSRF token" });
      }

      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_explore_tabs");
      if (!collection) {
        return response.status(500).json({ error: "Tab storage unavailable" });
      }

      const { tabIds } = request.body;
      if (!Array.isArray(tabIds) || tabIds.length > 100) {
        return response.status(400).json({ error: "tabIds must be an array (max 100)" });
      }

      // Shape check stays here (it is request validation); decoding is core's
      // job, so this adapter never constructs an ObjectId.
      const objectIdPattern = /^[a-f\d]{24}$/;
      if (tabIds.some((id) => typeof id !== "string" || !objectIdPattern.test(id))) {
        return response.status(400).json({ error: "Invalid tab ID format" });
      }

      await reorderTabs(
        { ap_explore_tabs: collection },
        tabIds,
      );

      return response.json({ success: true });
    } catch (error) {
      return next(error);
    }
  };
}
