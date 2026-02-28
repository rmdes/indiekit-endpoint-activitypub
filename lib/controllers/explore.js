/**
 * Explore controller — browse public timelines from remote Mastodon-compatible instances.
 *
 * All remote API calls are server-side (no CORS issues).
 * Remote HTML is always passed through sanitizeContent() before storage.
 */

import { searchInstances, checkInstanceTimeline, getPopularAccounts } from "../fedidb.js";
import { getToken } from "../csrf.js";
import { validateInstance, validateHashtag, mapMastodonStatusToItem } from "./explore-utils.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 20;

// Re-export validateInstance for backward compatibility (used by tabs.js, index.js)
export { validateInstance } from "./explore-utils.js";

export function exploreController(mountPath) {
  return async (request, response, next) => {
    try {
      const rawInstance = request.query.instance || "";
      const scope = request.query.scope === "federated" ? "federated" : "local";
      const maxId = request.query.max_id || "";
      const rawHashtag = request.query.hashtag || "";
      const hashtag = rawHashtag ? validateHashtag(rawHashtag) : null;

      const csrfToken = getToken(request.session);
      const readerParent = { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") };

      // No instance specified — render clean initial page (no error)
      if (!rawInstance.trim()) {
        return response.render("activitypub-explore", {
          title: response.locals.__("activitypub.reader.explore.title"),
          readerParent,
          instance: "",
          scope,
          hashtag: hashtag || "",
          items: [],
          maxId: null,
          error: null,
          mountPath,
          csrfToken,
        });
      }

      const instance = validateInstance(rawInstance);
      if (!instance) {
        return response.render("activitypub-explore", {
          title: response.locals.__("activitypub.reader.explore.title"),
          readerParent,
          instance: rawInstance,
          scope,
          hashtag: hashtag || "",
          items: [],
          maxId: null,
          error: response.locals.__("activitypub.reader.explore.invalidInstance"),
          mountPath,
          csrfToken,
        });
      }

      // Build API URL: hashtag timeline or public timeline
      const isLocal = scope === "local";
      let apiUrl;
      if (hashtag) {
        apiUrl = new URL(`https://${instance}/api/v1/timelines/tag/${encodeURIComponent(hashtag)}`);
        apiUrl.searchParams.set("local", isLocal ? "true" : "false");
      } else {
        apiUrl = new URL(`https://${instance}/api/v1/timelines/public`);
        apiUrl.searchParams.set("local", isLocal ? "true" : "false");
      }
      apiUrl.searchParams.set("limit", String(MAX_RESULTS));
      if (maxId) apiUrl.searchParams.set("max_id", maxId);

      let items = [];
      let nextMaxId = null;
      let error = null;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const fetchRes = await fetch(apiUrl.toString(), {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!fetchRes.ok) {
          throw new Error(`Remote instance returned HTTP ${fetchRes.status}`);
        }

        const statuses = await fetchRes.json();

        if (!Array.isArray(statuses)) {
          throw new Error("Unexpected API response format");
        }

        items = statuses.map((s) => mapMastodonStatusToItem(s, instance));

        // Get next max_id from last item for pagination
        if (statuses.length === MAX_RESULTS && statuses.length > 0) {
          const last = statuses[statuses.length - 1];
          nextMaxId = last.id || null;
        }
      } catch (fetchError) {
        const msg = fetchError.name === "AbortError"
          ? response.locals.__("activitypub.reader.explore.timeout")
          : response.locals.__("activitypub.reader.explore.loadError");
        error = msg;
      }

      response.render("activitypub-explore", {
        title: response.locals.__("activitypub.reader.explore.title"),
        readerParent,
        instance,
        scope,
        hashtag: hashtag || "",
        items,
        maxId: nextMaxId,
        error,
        mountPath,
        csrfToken,
        // Pass empty interactionMap — explore posts are not in our DB
        interactionMap: {},
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint for explore page infinite scroll.
 * Returns JSON { html, maxId }.
 */
export function exploreApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const rawInstance = request.query.instance || "";
      const scope = request.query.scope === "federated" ? "federated" : "local";
      const maxId = request.query.max_id || "";
      const rawHashtag = request.query.hashtag || "";
      const hashtag = rawHashtag ? validateHashtag(rawHashtag) : null;

      const instance = validateInstance(rawInstance);
      if (!instance) {
        return response.status(400).json({ error: "Invalid instance" });
      }

      // Build API URL: hashtag timeline or public timeline
      const isLocal = scope === "local";
      let apiUrl;
      if (hashtag) {
        apiUrl = new URL(`https://${instance}/api/v1/timelines/tag/${encodeURIComponent(hashtag)}`);
        apiUrl.searchParams.set("local", isLocal ? "true" : "false");
      } else {
        apiUrl = new URL(`https://${instance}/api/v1/timelines/public`);
        apiUrl.searchParams.set("local", isLocal ? "true" : "false");
      }
      apiUrl.searchParams.set("limit", String(MAX_RESULTS));
      if (maxId) apiUrl.searchParams.set("max_id", maxId);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const fetchRes = await fetch(apiUrl.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!fetchRes.ok) {
        return response.status(502).json({ error: `Remote returned ${fetchRes.status}` });
      }

      const statuses = await fetchRes.json();
      if (!Array.isArray(statuses)) {
        return response.status(502).json({ error: "Unexpected API response" });
      }

      const items = statuses.map((s) => mapMastodonStatusToItem(s, instance));

      let nextMaxId = null;
      if (statuses.length === MAX_RESULTS && statuses.length > 0) {
        const last = statuses[statuses.length - 1];
        nextMaxId = last.id || null;
      }

      // Render each card server-side
      const templateData = {
        ...response.locals,
        mountPath,
        csrfToken: "",
        interactionMap: {},
      };

      const htmlParts = await Promise.all(
        items.map((item) => {
          return new Promise((resolve, reject) => {
            request.app.render(
              "partials/ap-item-card.njk",
              { ...templateData, item },
              (err, html) => {
                if (err) reject(err);
                else resolve(html);
              }
            );
          });
        })
      );

      response.json({
        html: htmlParts.join(""),
        maxId: nextMaxId,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint for instance autocomplete.
 * Returns JSON array of matching instances from FediDB.
 */
export function instanceSearchApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const q = (request.query.q || "").trim();
      if (!q || q.length < 2) {
        return response.json([]);
      }

      const { application } = request.app.locals;
      const kvCollection = application?.collections?.get("ap_kv") || null;

      const results = await searchInstances(kvCollection, q, 8);
      response.json(results);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint to check if an instance supports public timeline exploration.
 * Returns JSON { supported: boolean, error: string|null }.
 */
export function instanceCheckApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const domain = (request.query.domain || "").trim().toLowerCase();
      if (!domain) {
        return response.status(400).json({ supported: false, error: "Missing domain" });
      }

      // Validate domain to prevent SSRF
      const validated = validateInstance(domain);
      if (!validated) {
        return response.status(400).json({ supported: false, error: "Invalid domain" });
      }

      const { application } = request.app.locals;
      const kvCollection = application?.collections?.get("ap_kv") || null;

      const result = await checkInstanceTimeline(kvCollection, validated);
      response.json(result);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * AJAX API endpoint for popular fediverse accounts.
 * Returns the full cached list; client-side filtering via Alpine.js.
 */
export function popularAccountsApiController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const kvCollection = application?.collections?.get("ap_kv") || null;

      const accounts = await getPopularAccounts(kvCollection, 50);
      response.json(accounts);
    } catch (error) {
      next(error);
    }
  };
}
