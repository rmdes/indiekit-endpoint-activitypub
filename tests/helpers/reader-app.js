/**
 * Drives the reader lane over real HTTP, with a Nunjucks environment wired the
 * way Indiekit wires it in production.
 *
 * Why this is needed: `lib/controllers/api-timeline.js` returns JSON, but the
 * JSON contains server-rendered HTML cards — `item-processing.js#renderItemCards`
 * calls `request.app.render("partials/ap-item-card.njk", …)`. Without a
 * configured view environment the endpoint 500s, so function-level tests miss
 * an entire adapter.
 *
 * `templates(app)` from @indiekit/frontend is the same factory the host uses:
 * it prepends the frontend's components/ and layouts/ to the app's own views,
 * which is why `{% extends "document.njk" %}` resolves.
 *
 * Only the controllers under test are mounted. Mounting the full admin router
 * would drag in IndieAuth session middleware that has nothing to do with the
 * defects this suite targets.
 */
import { fileURLToPath } from "node:url";

import express from "express";
import { templates } from "@indiekit/frontend";

import { apiTimelineController } from "../../lib/controllers/api-timeline.js";

const PLUGIN_VIEWS = fileURLToPath(new URL("../../views", import.meta.url));

/**
 * @param {Map<string, import("mongodb").Collection>} collectionMap
 * @returns {import("express").Express}
 */
export function makeReaderApp(collectionMap) {
  const app = express();

  app.set("views", [PLUGIN_VIEWS]);
  const env = templates(app);

  // Indiekit installs `__` (i18n lookup) as a Nunjucks global at host level.
  // Echo the key back: these tests assert structure and data, never copy, so a
  // real catalogue would add a dependency without adding signal.
  env.addGlobal("__", (key) => key);

  // Controllers reach collections through `application.collections` (a Map),
  // mirroring how Indiekit exposes them on app.locals.
  app.locals.application = { collections: collectionMap };

  // Templates reference these; absent values render as empty rather than throw.
  app.locals.publication = { me: "https://local.example/" };

  // Minimal in-memory session. csrf.js#getToken writes `_csrfToken` onto it and
  // the controllers embed that in responses; without a session object they 500.
  // Per-request and non-persistent, which is all the read paths need.
  app.use((req, _res, next) => {
    req.session = req.session || {};
    next();
  });

  app.get("/admin/reader/api/timeline", apiTimelineController("/activitypub"));

  return app;
}
