/**
 * Migration controller — handles Mastodon account migration UI.
 *
 * GET: shows the 3-step migration page
 * POST /admin/migrate: alias update (small form POST)
 * POST /admin/migrate/import: CSV import (JSON via fetch, bypasses body size limit)
 */

import {
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
 * JSON endpoint for import — receives { handles, importTypes }.
 * CSV is parsed client-side to extract handles only, keeping the
 * JSON payload small enough for Express's default body parser limit.
 */
export function migrateImportController(mountPath, pluginOptions) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const { handles, importTypes } = request.body;

      if (!Array.isArray(handles) || handles.length === 0) {
        return response.status(400).json({
          type: "error",
          text: "No handles provided.",
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
        console.log(`[ActivityPub] Migration: importing ${handles.length} following handles`);
        followingResult = await bulkImportFollowing(handles, followingCollection);
      }

      if (importFollowers && followersCollection) {
        console.log(`[ActivityPub] Migration: importing ${handles.length} follower entries`);
        followersResult = await bulkImportFollowers(handles, followersCollection);
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
