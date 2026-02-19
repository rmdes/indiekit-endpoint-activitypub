/**
 * Migration controller — handles Mastodon account migration UI.
 *
 * GET: shows the 3-step migration page
 * POST: processes alias update or CSV file import
 */

import {
  parseMastodonFollowingCsv,
  parseMastodonFollowersList,
  bulkImportFollowing,
  bulkImportFollowers,
} from "../migration.js";

export function migrateGetController(mountPath, pluginOptions) {
  return async (request, response, next) => {
    try {
      response.render("activitypub-migrate", {
        title: response.locals.__("activitypub.migrate.title"),
        mountPath,
        currentAlias: pluginOptions.alsoKnownAs || "",
        result: null,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function migratePostController(mountPath, pluginOptions) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const action = request.body.action;
      let result = null;

      if (action === "alias") {
        // Update alsoKnownAs on the actor config
        const aliasUrl = request.body.aliasUrl?.trim();
        if (aliasUrl) {
          pluginOptions.alsoKnownAs = aliasUrl;
          result = {
            type: "success",
            text: response.locals.__("activitypub.migrate.aliasSuccess"),
          };
        }
      }

      if (action === "import") {
        const followingCollection =
          application?.collections?.get("ap_following");
        const followersCollection =
          application?.collections?.get("ap_followers");

        const importFollowing = request.body.importTypes?.includes("following");
        const importFollowers = request.body.importTypes?.includes("followers");

        // Read file content (submitted as text via client-side FileReader)
        const fileContent = request.body.csvContent?.trim();
        if (!fileContent) {
          result = {
            type: "error",
            text: response.locals.__("activitypub.migrate.errorNoFile"),
          };
        } else {
          let followingResult = { imported: 0, failed: 0 };
          let followersResult = { imported: 0, failed: 0 };

          if (importFollowing && followingCollection) {
            const handles = parseMastodonFollowingCsv(fileContent);
            followingResult = await bulkImportFollowing(
              handles,
              followingCollection,
            );
          }

          if (importFollowers && followersCollection) {
            const entries = parseMastodonFollowersList(fileContent);
            followersResult = await bulkImportFollowers(
              entries,
              followersCollection,
            );
          }

          const totalFailed =
            followingResult.failed + followersResult.failed;
          result = {
            type: "success",
            text: response.locals
              .__("activitypub.migrate.success")
              .replace("%d", followingResult.imported)
              .replace("%d", followersResult.imported)
              .replace("%d", totalFailed),
          };
        }
      }

      response.render("activitypub-migrate", {
        title: response.locals.__("activitypub.migrate.title"),
        mountPath,
        currentAlias: pluginOptions.alsoKnownAs || "",
        result,
      });
    } catch (error) {
      next(error);
    }
  };
}

