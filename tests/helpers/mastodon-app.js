/**
 * Mounts the Mastodon Client API router on a bare Express app so the parity
 * suite can drive that lane over real HTTP against a real MongoDB.
 *
 * The defects this suite targets live in query construction and route wiring,
 * not in pure functions — so the router has to be exercised as mounted, not
 * imported piecemeal.
 */
import express from "express";

import { createMastodonRouter } from "../../lib/mastodon/router.js";
import { OAUTH_TOKEN } from "./fixtures.js";

export const BEARER = `Bearer ${OAUTH_TOKEN.accessToken}`;

/**
 * @param {Record<string, import("mongodb").Collection>} collections
 * @param {object} [pluginOptions] - Overrides merged into the defaults
 * @returns {import("express").Express}
 */
export function makeMastodonApp(collections, pluginOptions = {}) {
  const app = express();

  app.use(
    createMastodonRouter({
      collections,
      pluginOptions: {
        handle: "rick",
        publicationUrl: "https://local.example/",
        // Federation is only needed by write paths that deliver activities;
        // the read-path parity tests never reach it.
        federation: null,
        followActor: async () => ({ ok: true }),
        unfollowActor: async () => ({ ok: true }),
        broadcastActorUpdate: async () => {},
        loadRsaKey: async () => null,
        ...pluginOptions,
      },
    }),
  );

  return app;
}
