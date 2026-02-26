/**
 * Tag timeline controller — shows posts from the timeline filtered by a specific hashtag.
 */

import { getTimelineItems } from "../storage/timeline.js";
import { getToken } from "../csrf.js";
import {
  getMutedUrls,
  getMutedKeywords,
  getBlockedUrls,
  getFilterMode,
} from "../storage/moderation.js";

export function tagTimelineController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_timeline: application?.collections?.get("ap_timeline"),
      };

      // Validate tag parameter
      const tag = typeof request.query.tag === "string" ? request.query.tag.trim() : "";
      if (!tag) {
        return response.redirect(`${mountPath}/admin/reader`);
      }

      const before = request.query.before;
      const after = request.query.after;
      const limit = Math.min(
        Number.isFinite(Number.parseInt(request.query.limit, 10))
          ? Number.parseInt(request.query.limit, 10)
          : 20,
        100
      );

      // Get timeline items filtered by tag
      const result = await getTimelineItems(collections, { before, after, limit, tag });
      let items = result.items;

      // Apply moderation filters (same as main reader)
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

      // Get interaction state for liked/boosted indicators
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

      // Check if this hashtag is followed (Task 7 will populate ap_followed_tags)
      const followedTagsCol = application?.collections?.get("ap_followed_tags");
      let isFollowed = false;
      if (followedTagsCol) {
        const followed = await followedTagsCol.findOne({
          tag: { $regex: new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }
        });
        isFollowed = !!followed;
      }

      const csrfToken = getToken(request.session);

      response.render("activitypub-tag-timeline", {
        title: `#${tag}`,
        tag,
        items,
        before: result.before,
        after: result.after,
        interactionMap,
        csrfToken,
        mountPath,
        isFollowed,
      });
    } catch (error) {
      next(error);
    }
  };
}
