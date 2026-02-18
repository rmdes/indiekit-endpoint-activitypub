/**
 * Following list controller — paginated list of accounts this actor follows.
 */
const PAGE_SIZE = 20;

export function followingController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_following");

      if (!collection) {
        return response.render("following", {
          title: response.locals.__("activitypub.following"),
          following: [],
          followingCount: 0,
          mountPath,
        });
      }

      const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
      const totalCount = await collection.countDocuments();
      const totalPages = Math.ceil(totalCount / PAGE_SIZE);

      const following = await collection
        .find()
        .sort({ followedAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .toArray();

      const cursor = buildCursor(page, totalPages, mountPath + "/admin/following");

      response.render("following", {
        title: response.locals.__("activitypub.following"),
        following,
        followingCount: totalCount,
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
