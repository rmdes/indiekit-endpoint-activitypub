/**
 * Followers list controller — paginated list of accounts following this actor,
 * with pending follow requests tab when manual approval is enabled.
 */
import { count, findOne, list, removeOne, upsert } from "../core/collections-io.js";
import { getToken } from "../csrf.js";

const PAGE_SIZE = 20;

export function followersController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_followers");
      const pendingCol = application?.collections?.get("ap_pending_follows");

      const tab = request.query.tab || "followers";

      if (!collection) {
        return response.render("activitypub-followers", {
          title: response.locals.__("activitypub.followers"),
          parent: { href: mountPath, text: response.locals.__("activitypub.title") },
          followers: [],
          followerCount: 0,
          pendingFollows: [],
          pendingCount: 0,
          tab,
          mountPath,
          csrfToken: getToken(request),
        });
      }

      const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);

      // Count pending follow requests
      const pendingCount = pendingCol
        ? await pendingCol.countDocuments()
        : 0;

      if (tab === "pending") {
        // Show pending follow requests
        const totalPages = Math.ceil(pendingCount / PAGE_SIZE);
        const pendingFollows = pendingCol
          ? await pendingCol
              .find()
              .sort({ requestedAt: -1 })
              .skip((page - 1) * PAGE_SIZE)
              .limit(PAGE_SIZE)
              .toArray()
          : [];

        const cursor = buildCursor(page, totalPages, mountPath + "/admin/followers?tab=pending");

        return response.render("activitypub-followers", {
          title: response.locals.__("activitypub.followers"),
          parent: { href: mountPath, text: response.locals.__("activitypub.title") },
          followers: [],
          followerCount: await count(collection),
          pendingFollows,
          pendingCount,
          tab,
          mountPath,
          cursor,
          csrfToken: getToken(request),
        });
      }

      // Show accepted followers (default)
      const totalCount = await count(collection);
      const totalPages = Math.ceil(totalCount / PAGE_SIZE);

      const followers = await list(collection, {
        sort: { followedAt: -1 },
        skip: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });

      const cursor = buildCursor(page, totalPages, mountPath + "/admin/followers");

      response.render("activitypub-followers", {
        title: `${totalCount} ${response.locals.__("activitypub.followers")}`,
        parent: { href: mountPath, text: response.locals.__("activitypub.title") },
        followers,
        followerCount: totalCount,
        pendingFollows: [],
        pendingCount,
        tab,
        mountPath,
        cursor,
        csrfToken: getToken(request),
      });
    } catch (error) {
      next(error);
    }
  };
}

function buildCursor(page, totalPages, basePath) {
  if (totalPages <= 1) return null;

  const separator = basePath.includes("?") ? "&" : "?";

  return {
    previous: page > 1
      ? { href: `${basePath}${separator}page=${page - 1}` }
      : undefined,
    next: page < totalPages
      ? { href: `${basePath}${separator}page=${page + 1}` }
      : undefined,
  };
}
