/**
 * Search endpoint for Mastodon Client API.
 *
 * GET /api/v2/search — search accounts, statuses, and hashtags
 */
import express from "express";
import { serializeStatus } from "../entities/status.js";
import { serializeAccount } from "../entities/account.js";
import { parseLimit } from "../helpers/pagination.js";
import { resolveRemoteAccount } from "../helpers/resolve-account.js";
import { lookupWithSecurity } from "../../lookup-helpers.js";
import { extractObjectData } from "../../timeline-store.js";
import { addTimelineItem } from "../../storage/timeline.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v2/search ─────────────────────────────────────────────────────

router.get("/api/v2/search", tokenRequired, scopeRequired("read", "read:search"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const query = (req.query.q || "").trim();
    const type = req.query.type; // "accounts", "statuses", "hashtags", or undefined (all)
    const limit = parseLimit(req.query.limit);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

    const resolve = req.query.resolve === "true";
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};

    if (!query) {
      return res.json({ accounts: [], statuses: [], hashtags: [] });
    }

    const results = { accounts: [], statuses: [], hashtags: [] };

    // ─── Account search ──────────────────────────────────────────────────
    if (!type || type === "accounts") {
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const nameRegex = new RegExp(escapedQuery, "i");

      // Search followers and following by display name or handle
      const accountDocs = [];

      if (collections.ap_followers) {
        const followers = await collections.ap_followers
          .find({
            $or: [
              { name: nameRegex },
              { preferredUsername: nameRegex },
              { url: nameRegex },
            ],
          })
          .limit(limit)
          .toArray();
        accountDocs.push(...followers);
      }

      if (collections.ap_following) {
        const following = await collections.ap_following
          .find({
            $or: [
              { name: nameRegex },
              { preferredUsername: nameRegex },
              { url: nameRegex },
            ],
          })
          .limit(limit)
          .toArray();
        accountDocs.push(...following);
      }

      // Deduplicate by URL
      const seen = new Set();
      for (const doc of accountDocs) {
        const url = doc.url || doc.id;
        if (url && !seen.has(url)) {
          seen.add(url);
          results.accounts.push(
            serializeAccount(doc, { baseUrl, isRemote: true }),
          );
        }
        if (results.accounts.length >= limit) break;
      }

    }

    // ─── Status search ───────────────────────────────────────────────────
    if (!type || type === "statuses") {
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const contentRegex = new RegExp(escapedQuery, "i");

      const items = await collections.ap_timeline
        .find({
          isContext: { $ne: true },
          $or: [
            { "content.text": contentRegex },
            { "content.html": contentRegex },
          ],
        })
        .sort({ _id: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      results.statuses = items.map((item) =>
        serializeStatus(item, {
          baseUrl,
          favouritedIds: new Set(),
          rebloggedIds: new Set(),
          bookmarkedIds: new Set(),
          pinnedIds: new Set(),
        }),
      );
    }

    // ─── Hashtag search ──────────────────────────────────────────────────
    if (!type || type === "hashtags") {
      const escapedQuery = query
        .replace(/^#/, "")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tagRegex = new RegExp(escapedQuery, "i");

      // Find distinct category values matching the query
      const allCategories = await collections.ap_timeline.distinct("category", {
        category: tagRegex,
      });

      // Flatten and deduplicate (category can be string or array)
      const tagSet = new Set();
      for (const cat of allCategories) {
        if (Array.isArray(cat)) {
          for (const c of cat) {
            if (typeof c === "string" && tagRegex.test(c)) tagSet.add(c);
          }
        } else if (typeof cat === "string" && tagRegex.test(cat)) {
          tagSet.add(cat);
        }
      }

      results.hashtags = [...tagSet].slice(0, limit).map((name) => ({
        name,
        url: `${baseUrl}/tags/${encodeURIComponent(name)}`,
        history: [],
      }));
    }

    // ─── Remote resolution (resolve=true) ────────────────────────────────
    // "Open this profile / post in my app" — Phanpy/Elk paste a handle or URL.
    // Do a single signed lookup and route the result to accounts or statuses.
    const isUrl = /^https?:\/\//i.test(query);
    const isHandle = query.includes("@");
    if (resolve && (isUrl || isHandle)) {
      // Account resolution (handle OR URL) — covers the mangled-@-URL case now
      // that resolveRemoteAccount checks http(s) first.
      if ((!type || type === "accounts") && results.accounts.length === 0) {
        const acc = await resolveRemoteAccount(query, pluginOptions, baseUrl);
        if (acc) results.accounts.push(acc);
      }

      // Status resolution (URL only, and only if it wasn't an actor): fetch the
      // object; if it's a Note/Article, store it (gets a real id) and serialize.
      if (
        isUrl &&
        (!type || type === "statuses") &&
        results.statuses.length === 0 &&
        results.accounts.length === 0
      ) {
        try {
          const { federation, handle, publicationUrl } = pluginOptions;
          if (federation) {
            const ctx = federation.createContext(new URL(publicationUrl), {
              handle,
              publicationUrl,
            });
            const documentLoader = await ctx
              .getDocumentLoader({ identifier: handle })
              .catch(() => undefined);
            const obj = await lookupWithSecurity(
              ctx,
              query,
              documentLoader ? { documentLoader } : {},
            );
            // Actors have an inbox; Note/Article do not. Only store content objects.
            if (obj && !obj.inboxId && (obj.content || obj.name)) {
              const item = await extractObjectData(obj, { documentLoader });
              const stored = await addTimelineItem(collections, item);
              if (stored) {
                results.statuses.push(
                  serializeStatus(stored, {
                    baseUrl,
                    favouritedIds: new Set(),
                    rebloggedIds: new Set(),
                    bookmarkedIds: new Set(),
                    pinnedIds: new Set(),
                  }),
                );
              }
            }
          }
        } catch (error) {
          console.warn(`[Mastodon API] status resolution failed for ${query}: ${error.message}`);
        }
      }
    }

    res.json(results);
  } catch (error) {
    next(error);
  }
});

export default router;
