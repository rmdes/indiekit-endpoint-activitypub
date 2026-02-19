/**
 * Migration controller — handles Mastodon account migration UI.
 *
 * GET: shows the 3-step migration page
 * POST /admin/migrate: alias update (small form POST)
 * POST /admin/migrate/import: CSV import (JSON via fetch, bypasses body size limit)
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
      let result = null;

      // Only handles alias updates (small payload, regular form POST)
      const aliasUrl = request.body.aliasUrl?.trim();
      if (aliasUrl) {
        pluginOptions.alsoKnownAs = aliasUrl;
        result = {
          type: "success",
          text: response.locals.__("activitypub.migrate.aliasSuccess"),
        };
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

/**
 * JSON endpoint for CSV import — receives { csvContent, importTypes }
 * via fetch() to bypass Express's app-level urlencoded body size limit.
 */
export function migrateImportController(mountPath, pluginOptions) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const { csvContent, importTypes } = request.body;

      if (!csvContent?.trim()) {
        return response.status(400).json({
          type: "error",
          text: "No CSV content provided.",
        });
      }

      const followingCollection =
        application?.collections?.get("ap_following");
      const followersCollection =
        application?.collections?.get("ap_followers");

      const importFollowing = importTypes?.includes("following");
      const importFollowers = importTypes?.includes("followers");

      let followingResult = { imported: 0, failed: 0, errors: [] };
      let followersResult = { imported: 0, failed: 0, errors: [] };

      if (importFollowing && followingCollection) {
        const handles = parseMastodonFollowingCsv(csvContent);
        console.log(`[ActivityPub] Migration: parsed ${handles.length} following handles from CSV`);
        followingResult = await bulkImportFollowing(handles, followingCollection);
      }

      if (importFollowers && followersCollection) {
        const entries = parseMastodonFollowersList(csvContent);
        console.log(`[ActivityPub] Migration: parsed ${entries.length} follower entries from CSV`);
        followersResult = await bulkImportFollowers(entries, followersCollection);
      }

      const totalFailed = followingResult.failed + followersResult.failed;
      const totalImported = followingResult.imported + followersResult.imported;
      const allErrors = [...followingResult.errors, ...followersResult.errors];

      return response.json({
        type: totalFailed > 0 && totalImported === 0 ? "error" : "success",
        followingImported: followingResult.imported,
        followersImported: followersResult.imported,
        failed: totalFailed,
        errors: allErrors,
      });
    } catch (error) {
      console.error("[ActivityPub] Migration import error:", error.message);
      return response.status(500).json({
        type: "error",
        text: error.message,
      });
    }
  };
}
