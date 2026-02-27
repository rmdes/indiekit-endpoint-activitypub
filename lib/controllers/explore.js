/**
 * Explore controller — browse public timelines from remote Mastodon-compatible instances.
 *
 * All remote API calls are server-side (no CORS issues).
 * Remote HTML is always passed through sanitizeContent() before storage.
 */

import sanitizeHtml from "sanitize-html";
import { sanitizeContent } from "../timeline-store.js";
import { searchInstances, checkInstanceTimeline, getPopularAccounts } from "../fedidb.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 20;

/**
 * Validate the instance parameter to prevent SSRF.
 * Only allows hostnames — no IPs, no localhost, no port numbers for exotic attacks.
 * @param {string} instance - Raw instance parameter from query string
 * @returns {string|null} Validated hostname or null
 */
function validateInstance(instance) {
  if (!instance || typeof instance !== "string") return null;

  try {
    // Prepend https:// to parse as URL
    const url = new URL(`https://${instance.trim()}`);

    // Must be a plain hostname — no IP addresses, no localhost
    const hostname = url.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(hostname) || // IPv4
      hostname.includes("[") // IPv6
    ) {
      return null;
    }

    // Only allow the hostname (no path, no port override)
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Map a Mastodon API status object to our timeline item format.
 * @param {object} status - Mastodon API status
 * @param {string} instance - Instance hostname (for handle construction)
 * @returns {object} Timeline item compatible with ap-item-card.njk
 */
function mapMastodonStatusToItem(status, instance) {
  const account = status.account || {};
  const acct = account.acct || "";
  // Mastodon acct is "user" for local, "user@remote" for remote
  const handle = acct.includes("@") ? `@${acct}` : `@${acct}@${instance}`;

  // Map mentions — store without leading @ (template prepends it)
  const mentions = (status.mentions || []).map((m) => ({
    name: m.acct.includes("@") ? m.acct : `${m.acct}@${instance}`,
    url: m.url || "",
  }));

  // Map hashtags
  const category = (status.tags || []).map((t) => t.name || "");

  // Map media attachments
  const photo = [];
  const video = [];
  const audio = [];
  for (const att of status.media_attachments || []) {
    const url = att.url || att.remote_url || "";
    if (!url) continue;
    if (att.type === "image" || att.type === "gifv") {
      photo.push(url);
    } else if (att.type === "video") {
      video.push(url);
    } else if (att.type === "audio") {
      audio.push(url);
    }
  }

  return {
    uid: status.url || status.uri || "",
    url: status.url || status.uri || "",
    type: "note",
    name: "",
    content: {
      text: (status.content || "").replace(/<[^>]*>/g, ""),
      html: sanitizeContent(status.content || ""),
    },
    summary: status.spoiler_text || "",
    sensitive: status.sensitive || false,
    published: status.created_at || new Date().toISOString(),
    author: {
      name: sanitizeHtml(account.display_name || account.username || "Unknown", { allowedTags: [], allowedAttributes: {} }),
      url: account.url || "",
      photo: account.avatar || account.avatar_static || "",
      handle,
    },
    category,
    mentions,
    photo,
    video,
    audio,
    inReplyTo: status.in_reply_to_id ? `https://${instance}/web/statuses/${status.in_reply_to_id}` : "",
    createdAt: new Date().toISOString(),
    // Explore-specific: track source instance
    _explore: true,
  };
}

export function exploreController(mountPath) {
  return async (request, response, next) => {
    try {
      const rawInstance = request.query.instance || "";
      const scope = request.query.scope === "federated" ? "federated" : "local";
      const maxId = request.query.max_id || "";

      // No instance specified — render clean initial page (no error)
      if (!rawInstance.trim()) {
        return response.render("activitypub-explore", {
          title: response.locals.__("activitypub.reader.explore.title"),
          instance: "",
          scope,
          items: [],
          maxId: null,
          error: null,
          mountPath,
        });
      }

      const instance = validateInstance(rawInstance);
      if (!instance) {
        return response.render("activitypub-explore", {
          title: response.locals.__("activitypub.reader.explore.title"),
          instance: rawInstance,
          scope,
          items: [],
          maxId: null,
          error: response.locals.__("activitypub.reader.explore.invalidInstance"),
          mountPath,
        });
      }

      // Fetch public timeline from remote instance
      const isLocal = scope === "local";
      const apiUrl = new URL(`https://${instance}/api/v1/timelines/public`);
      apiUrl.searchParams.set("local", isLocal ? "true" : "false");
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
        instance,
        scope,
        items,
        maxId: nextMaxId,
        error,
        mountPath,
        // Pass empty interactionMap — explore posts are not in our DB
        interactionMap: {},
        csrfToken: "",
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

      const instance = validateInstance(rawInstance);
      if (!instance) {
        return response.status(400).json({ error: "Invalid instance" });
      }

      const isLocal = scope === "local";
      const apiUrl = new URL(`https://${instance}/api/v1/timelines/public`);
      apiUrl.searchParams.set("local", isLocal ? "true" : "false");
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
