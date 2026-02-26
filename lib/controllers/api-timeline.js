/**
 * JSON API timeline endpoint — returns pre-rendered HTML cards for infinite scroll AJAX loads.
 */

import { getTimelineItems } from "../storage/timeline.js";
import { getToken } from "../csrf.js";
import {
  getMutedUrls,
  getMutedKeywords,
  getBlockedUrls,
  getFilterMode,
} from "../storage/moderation.js";

export function apiTimelineController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      // Query parameters
      const tab = request.query.tab || "notes";
      const tag = typeof request.query.tag === "string" ? request.query.tag.trim() : "";
      const before = request.query.before;
      const limit = 20;

      // Build storage query options (same logic as readerController)
      const options = { before, limit };

      if (tag) {
        options.tag = tag;
      } else {
        if (tab === "notes") {
          options.type = "note";
          options.excludeReplies = true;
        } else if (tab === "articles") {
          options.type = "article";
        } else if (tab === "boosts") {
          options.type = "boost";
        }
      }

      const result = await getTimelineItems(collections, options);

      // Client-side tab filtering for types not supported by storage
      let items = result.items;
      if (!tag) {
        if (tab === "replies") {
          items = items.filter((item) => item.inReplyTo);
        } else if (tab === "media") {
          items = items.filter(
            (item) =>
              (item.photo && item.photo.length > 0) ||
              (item.video && item.video.length > 0) ||
              (item.audio && item.audio.length > 0)
          );
        }
      }

      // Apply moderation filters
      const modCollections = {
        ap_muted: application?.collections?.get("ap_muted"),
        ap_blocked: application?.collections?.get("ap_blocked"),
        ap_profile: application?.collections?.get("ap_profile"),
      };
      const [mutedUrls, mutedKeywords, blockedUrls, filterMode] =
        await Promise.all([
          getMutedUrls(modCollections),
          getMutedKeywords(modCollections),
          getBlockedUrls(modCollections),
          getFilterMode(modCollections),
        ]);
      const blockedSet = new Set(blockedUrls);
      const mutedSet = new Set(mutedUrls);

      if (blockedSet.size > 0 || mutedSet.size > 0 || mutedKeywords.length > 0) {
        items = items.filter((item) => {
          if (item.author?.url && blockedSet.has(item.author.url)) {
            return false;
          }

          const isMutedActor = item.author?.url && mutedSet.has(item.author.url);
          let matchedKeyword = null;
          if (mutedKeywords.length > 0) {
            const searchable = [item.content?.text, item.name, item.summary]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            if (searchable) {
              matchedKeyword = mutedKeywords.find((kw) =>
                searchable.includes(kw.toLowerCase())
              );
            }
          }

          if (isMutedActor || matchedKeyword) {
            if (filterMode === "warn") {
              item._moderated = true;
              item._moderationReason = isMutedActor ? "muted_account" : "muted_keyword";
              if (matchedKeyword) item._moderationKeyword = matchedKeyword;
              return true;
            }
            return false;
          }

          return true;
        });
      }

      // Get interaction state
      const interactionsCol = application?.collections?.get("ap_interactions");
      const interactionMap = {};

      if (interactionsCol) {
        const lookupUrls = new Set();
        const objectUrlToUid = new Map();
        for (const item of items) {
          const uid = item.uid;
          const displayUrl = item.url || item.originalUrl;
          if (uid) { lookupUrls.add(uid); objectUrlToUid.set(uid, uid); }
          if (displayUrl) { lookupUrls.add(displayUrl); objectUrlToUid.set(displayUrl, uid || displayUrl); }
        }
        if (lookupUrls.size > 0) {
          const interactions = await interactionsCol
            .find({ objectUrl: { $in: [...lookupUrls] } })
            .toArray();
          for (const interaction of interactions) {
            const key = objectUrlToUid.get(interaction.objectUrl) || interaction.objectUrl;
            if (!interactionMap[key]) interactionMap[key] = {};
            interactionMap[key][interaction.type] = true;
          }
        }
      }

      const csrfToken = getToken(request.session);

      // Render each card server-side using the same Nunjucks template
      // Merge response.locals so that i18n (__), mountPath, etc. are available
      const templateData = {
        ...response.locals,
        mountPath,
        csrfToken,
        interactionMap,
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
        before: result.before,
      });
    } catch (error) {
      next(error);
    }
  };
}
