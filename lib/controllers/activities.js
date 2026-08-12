import { count, findOne, list, removeOne, upsert } from "../core/collections-io.js";
/**
 * Activity log controller — paginated list of inbound/outbound activities.
 */
const PAGE_SIZE = 20;

export function activitiesController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_activities");

      if (!collection) {
        return response.render("activitypub-activities", {
          title: response.locals.__("activitypub.activities"),
          parent: { href: mountPath, text: response.locals.__("activitypub.title") },
          activities: [],
          mountPath,
        });
      }

      const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
      const totalCount = await count(collection);
      const totalPages = Math.ceil(totalCount / PAGE_SIZE);

      const activities = await list(collection, {
        sort: { receivedAt: -1 },
        skip: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });

      const cursor = buildCursor(page, totalPages, mountPath + "/admin/activities");

      response.render("activitypub-activities", {
        title: response.locals.__("activitypub.activities"),
        parent: { href: mountPath, text: response.locals.__("activitypub.title") },
        activities,
        mountPath,
        cursor,
      });
    } catch (error) {
      next(error);
    }
  };
}

function buildCursor(page, totalPages, basePath) {
  if (totalPages <= 1) return null;

  return {
    previous: page > 1
      ? { href: `${basePath}?page=${page - 1}` }
      : undefined,
    next: page < totalPages
      ? { href: `${basePath}?page=${page + 1}` }
      : undefined,
  };
}
