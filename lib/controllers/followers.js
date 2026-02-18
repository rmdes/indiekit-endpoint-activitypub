/**
 * Followers list controller — paginated list of accounts following this actor.
 */
const PAGE_SIZE = 20;

export function followersController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_followers");

      if (!collection) {
        return response.render("activitypub-followers", {
          title: response.locals.__("activitypub.followers"),
          followers: [],
          followerCount: 0,
          mountPath,
        });
      }

      const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
      const totalCount = await collection.countDocuments();
      const totalPages = Math.ceil(totalCount / PAGE_SIZE);

      const followers = await collection
        .find()
        .sort({ followedAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .toArray();

      const cursor = buildCursor(page, totalPages, mountPath + "/admin/followers");

      response.render("activitypub-followers", {
        title: response.locals.__("activitypub.followers"),
        followers,
        followerCount: totalCount,
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
