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

import { ObjectId } from "mongodb";
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

      const tabs = await collection
        .find({}, { projection: { _id: 1, type: 1, domain: 1, scope: 1, hashtag: 1, order: 1, addedAt: 1 } })
        .sort({ order: 1 })
        .toArray();

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

      // Determine the next order value atomically
      const lastTab = await collection
        .find({})
        .sort({ order: -1 })
        .limit(1)
        .toArray();
      const nextOrder = lastTab.length > 0 ? lastTab[0].order + 1 : 0;

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
          order: nextOrder,
          addedAt: new Date().toISOString(),
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
          order: nextOrder,
          addedAt: new Date().toISOString(),
        };
      }

      try {
        const result = await collection.insertOne(tab);
        // Return with the MongoDB _id included
        return response.status(201).json({ ...tab, _id: result.insertedId });
      } catch (insertError) {
        if (insertError.code === 11_000) {
          return response.status(409).json({ error: "Tab already exists" });
        }
        throw insertError;
      }
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

      await collection.deleteOne(filter);

      // Re-compact order numbers to avoid gaps
      const remaining = await collection.find({}).sort({ order: 1 }).toArray();
      await Promise.all(
        remaining.map((tab, index) =>
          collection.updateOne({ _id: tab._id }, { $set: { order: index } }),
        ),
      );

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

      // Validate each ID is a valid ObjectId hex string
      const objectIdPattern = /^[a-f\d]{24}$/;
      if (tabIds.some((id) => typeof id !== "string" || !objectIdPattern.test(id))) {
        return response.status(400).json({ error: "Invalid tab ID format" });
      }

      await Promise.all(
        tabIds.map((id, index) =>
          collection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { order: index } },
          ),
        ),
      );

      return response.json({ success: true });
    } catch (error) {
      return next(error);
    }
  };
}
