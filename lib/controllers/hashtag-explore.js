/**
 * Hashtag explore API — aggregates a hashtag timeline across all pinned instance tabs.
 *
 * GET /admin/reader/api/explore/hashtag
 *   ?hashtag={tag}
 *   &cursors={json}   — JSON-encoded { domain: maxId } cursor map for pagination
 *
 * Returns JSON:
 *   {
 *     html: string,             — server-rendered HTML cards
 *     cursors: { [domain]: string|null },  — updated cursor map
 *     sources: { [domain]: "ok" | "error:N" },
 *     instancesQueried: number,
 *     instancesTotal: number,
 *     instanceLabels: string[],
 *   }
 */

import { validateHashtag, mapMastodonStatusToItem } from "./explore-utils.js";
import { getToken } from "../csrf.js";

const FETCH_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 20;
const MAX_HASHTAG_INSTANCES = 10;

/**
 * Fetch hashtag timeline from one instance.
 * Returns { statuses, nextMaxId, error }.
 */
async function fetchHashtagFromInstance(domain, scope, hashtag, maxId) {
  try {
    const isLocal = scope === "local";
    const url = new URL(
      `https://${domain}/api/v1/timelines/tag/${encodeURIComponent(hashtag)}`
    );
    url.searchParams.set("local", isLocal ? "true" : "false");
    url.searchParams.set("limit", "20");
    if (maxId) url.searchParams.set("max_id", maxId);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return { statuses: [], nextMaxId: null, error: `error:${res.status}` };
    }

    const statuses = await res.json();
    if (!Array.isArray(statuses)) {
      return { statuses: [], nextMaxId: null, error: "error:invalid" };
    }

    const nextMaxId =
      statuses.length === 20 && statuses.length > 0
        ? statuses[statuses.length - 1].id || null
        : null;

    return { statuses, nextMaxId, error: null };
  } catch {
    return { statuses: [], nextMaxId: null, error: "error:timeout" };
  }
}

/**
 * Hashtag explore API controller.
 * Queries up to MAX_HASHTAG_INSTANCES pinned instance tabs in parallel.
 */
export function hashtagExploreApiController(mountPath) {
  return async (request, response, next) => {
    try {
      // Validate hashtag
      const rawHashtag = request.query.hashtag || "";
      const hashtag = validateHashtag(rawHashtag);
      if (!hashtag) {
        return response.status(400).json({ error: "Invalid hashtag" });
      }

      const tabsCollection = request.app.locals.application?.collections?.get("ap_explore_tabs");
      if (!tabsCollection) {
        return response.json({
          html: "", cursors: {}, sources: {}, instancesQueried: 0, instancesTotal: 0, instanceLabels: [],
        });
      }

      // Parse cursors map — { [domain]: maxId | null }
      let cursors = {};
      try {
        const raw = request.query.cursors || "{}";
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          cursors = parsed;
        }
      } catch {
        // Invalid JSON — use empty cursors (start from beginning)
      }

      // Load instance tabs, capped at MAX_HASHTAG_INSTANCES by order
      const instanceTabs = await tabsCollection
        .find({ type: "instance" })
        .sort({ order: 1 })
        .limit(MAX_HASHTAG_INSTANCES)
        .toArray();

      const instancesTotal = await tabsCollection.countDocuments({
        type: "instance",
      });

      if (instanceTabs.length === 0) {
        return response.json({
          html: "",
          cursors: {},
          sources: {},
          instancesQueried: 0,
          instancesTotal,
          instanceLabels: [],
        });
      }

      // Fetch from all instances in parallel
      const fetchResults = await Promise.allSettled(
        instanceTabs.map((tab) =>
          fetchHashtagFromInstance(
            tab.domain,
            tab.scope,
            hashtag,
            cursors[tab.domain] || null
          )
        )
      );

      // Build sources map and collect all statuses with their domain
      const sources = {};
      const updatedCursors = {};
      const allItems = [];

      for (let i = 0; i < instanceTabs.length; i++) {
        const tab = instanceTabs[i];
        const result = fetchResults[i];

        if (result.status === "fulfilled") {
          const { statuses, nextMaxId, error } = result.value;
          sources[tab.domain] = error || "ok";
          updatedCursors[tab.domain] = nextMaxId;

          if (!error) {
            for (const status of statuses) {
              allItems.push({ status, domain: tab.domain });
            }
          }
        } else {
          sources[tab.domain] = "error:rejected";
          updatedCursors[tab.domain] = cursors[tab.domain] || null;
        }
      }

      // Merge by published date descending
      allItems.sort((a, b) => {
        const dateA = new Date(a.status.created_at || 0).getTime();
        const dateB = new Date(b.status.created_at || 0).getTime();
        return dateB - dateA;
      });

      // Deduplicate by post URL (first occurrence wins)
      const seenUrls = new Set();
      const dedupedItems = [];
      for (const { status, domain } of allItems) {
        const uid = status.url || status.uri || "";
        if (uid && seenUrls.has(uid)) continue;
        if (uid) seenUrls.add(uid);
        dedupedItems.push({ status, domain });
      }

      // Paginate: take first PAGE_SIZE items
      const pageItems = dedupedItems.slice(0, PAGE_SIZE);

      // Map to timeline item format
      const items = pageItems.map(({ status, domain }) =>
        mapMastodonStatusToItem(status, domain)
      );

      // Render HTML AFTER merge/dedup/paginate (don't waste CPU on discarded items)
      const csrfToken = getToken(request.session);
      const templateData = {
        ...response.locals,
        mountPath,
        csrfToken,
        interactionMap: {},
      };

      const htmlParts = await Promise.all(
        items.map(
          (item) =>
            new Promise((resolve, reject) => {
              request.app.render(
                "partials/ap-item-card.njk",
                { ...templateData, item },
                (err, html) => {
                  if (err) reject(err);
                  else resolve(html);
                }
              );
            })
        )
      );

      const instanceLabels = instanceTabs.map((t) => t.domain);

      response.json({
        html: htmlParts.join(""),
        cursors: updatedCursors,
        sources,
        instancesQueried: instanceTabs.length,
        instancesTotal,
        instanceLabels,
      });
    } catch (error) {
      next(error);
    }
  };
}
