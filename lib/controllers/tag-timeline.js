/**
 * Tag timeline controller — shows posts from the timeline filtered by a specific hashtag.
 */

import { getTimelineItems } from "../storage/timeline.js";
import { getToken } from "../csrf.js";
import { postProcessItems, loadModerationData } from "../item-processing.js";

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

      // Shared processing pipeline: moderation, quote stripping, interactions
      const modCollections = {
        ap_muted: application?.collections?.get("ap_muted"),
        ap_blocked: application?.collections?.get("ap_blocked"),
        ap_profile: application?.collections?.get("ap_profile"),
      };
      const moderation = await loadModerationData(modCollections);

      const { items, interactionMap } = await postProcessItems(result.items, {
        moderation,
        interactionsCol: application?.collections?.get("ap_interactions"),
      });

      // Check if this hashtag is followed (local and/or global)
      const followedTagsCol = application?.collections?.get("ap_followed_tags");
      let isFollowed = false;
      let isGloballyFollowed = false;
      if (followedTagsCol) {
        const followed = await followedTagsCol.findOne({
          tag: { $regex: new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }
        });
        isFollowed = !!(followed?.followedAt);
        isGloballyFollowed = !!(followed?.globalFollow);
      }

      const csrfToken = getToken(request.session);
      const error = typeof request.query.error === "string" ? request.query.error : null;

      response.render("activitypub-tag-timeline", {
        title: `#${tag}`,
        readerParent: { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") },
        hashtag: tag,
        items,
        before: result.before,
        after: result.after,
        interactionMap,
        csrfToken,
        mountPath,
        isFollowed,
        isGloballyFollowed,
        error,
      });
    } catch (error) {
      next(error);
    }
  };
}
