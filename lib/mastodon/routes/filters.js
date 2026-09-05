/**
 * Filter endpoints for Mastodon Client API v2.
 */
import express from "express";
import {
  createFilter,
  deleteFilter,
  getFilter,
  getFilters,
  replaceKeywords,
  updateFilter,
} from "../../core/filters.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

/**
 * Serialize a filter document with its keywords.
 */
function serializeFilter(filter, keywords = []) {
  return {
    id: filter._id.toString(),
    title: filter.title || "",
    context: filter.context || [],
    filter_action: filter.filterAction || "warn",
    expires_at: filter.expiresAt || null,
    keywords: keywords.map((kw) => ({
      id: kw._id.toString(),
      keyword: kw.keyword,
      whole_word: kw.wholeWord ?? true,
    })),
    statuses: [],
  };
}

// ─── GET /api/v2/filters ────────────────────────────────────────────────────

router.get("/api/v2/filters", tokenRequired, scopeRequired("read", "read:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;

    const filters = await getFilters(collections);

    res.json(filters.map((f) => serializeFilter(f, f.keywords)));
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/v2/filters ───────────────────────────────────────────────────

router.post("/api/v2/filters", tokenRequired, scopeRequired("write", "write:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;
    if (!collections.ap_filters) {
      return res.status(500).json({ error: "Filters not available" });
    }

    const {
      title,
      context,
      filter_action: filterAction = "warn",
      expires_in: expiresIn,
      keywords_attributes: keywordsAttributes,
    } = req.body;

    if (!title) {
      return res.status(422).json({ error: "title is required" });
    }

    const expiresAt = expiresIn
      ? new Date(Date.now() + Number.parseInt(expiresIn, 10) * 1000).toISOString()
      : null;

    const attrs = keywordsAttributes
      ? Array.isArray(keywordsAttributes)
        ? keywordsAttributes
        : Object.values(keywordsAttributes)
      : [];

    const created = await createFilter(
      collections,
      {
        title,
        context: Array.isArray(context) ? context : [context].filter(Boolean),
        filterAction,
        expiresAt,
      },
      attrs
        .filter((a) => a.keyword)
        .map((a) => ({
          keyword: a.keyword,
          wholeWord: a.whole_word !== "false" && a.whole_word !== false,
        })),
    );

    res.json(serializeFilter(created, created?.keywords || []));
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v2/filters/:id ────────────────────────────────────────────────

router.get("/api/v2/filters/:id", tokenRequired, scopeRequired("read", "read:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;

    const filter = await getFilter(collections, req.params.id);
    if (!filter) {
      return res.status(404).json({ error: "Record not found" });
    }

    res.json(serializeFilter(filter, filter.keywords));
  } catch (error) {
    next(error);
  }
});

// ─── PUT /api/v2/filters/:id ────────────────────────────────────────────────

router.put("/api/v2/filters/:id", tokenRequired, scopeRequired("write", "write:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;

    const existing = await getFilter(collections, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Record not found" });
    }

    const update = {};
    if (req.body.title !== undefined) update.title = req.body.title;
    if (req.body.context !== undefined) {
      update.context = Array.isArray(req.body.context)
        ? req.body.context
        : [req.body.context].filter(Boolean);
    }
    if (req.body.filter_action !== undefined) update.filterAction = req.body.filter_action;
    if (req.body.expires_in !== undefined) {
      update.expiresAt = req.body.expires_in
        ? new Date(Date.now() + Number.parseInt(req.body.expires_in, 10) * 1000).toISOString()
        : null;
    }

    const filter =
      Object.keys(update).length > 0
        ? await updateFilter(collections, req.params.id, update)
        : existing;

    res.json(serializeFilter(filter, filter?.keywords || []));
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/v2/filters/:id ─────────────────────────────────────────────

router.delete("/api/v2/filters/:id", tokenRequired, scopeRequired("write", "write:filters"), async (req, res, next) => {
  try {
    const collections = req.app.locals.mastodonCollections;

    // Core deletes the keywords too — orphans would keep filtering silently.
    await deleteFilter(collections, req.params.id);

    res.json({});
  } catch (error) {
    next(error);
  }
});

export default router;
