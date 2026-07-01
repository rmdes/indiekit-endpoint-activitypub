/**
 * Public (federation-facing) route getters, extracted from index.js's
 * `get routesPublic()` + `get contentNegotiationRoutes()` (Phase 2 god-entry split).
 * `self` is the ActivityPubEndpoint instance.
 */
import express from "express";

import { authorizeInteractionController } from "../controllers/authorize-interaction.js";
import { publicProfileController } from "../controllers/public-profile.js";
import { jf2ToActivityStreams } from "../jf2-to-as2.js";

/**
 * Public routes — Fedify bridge for actor/inbox/collections, plus HTML
 * fallbacks. Mounted at mountPath, in front of the authenticated admin routes.
 * @param {object} self - the ActivityPubEndpoint instance
 * @returns {import("express").Router}
 */
export function buildRoutesPublic(self) {
  const router = express.Router(); // eslint-disable-line new-cap

  router.use((req, res, next) => {
    if (!self._fedifyMiddleware) return next();
    // Skip Fedify for admin UI routes — they're handled by the
    // authenticated `routes` getter, not the federation layer.
    if (req.path.startsWith("/admin")) return next();

    // Fedify's acceptsJsonLd() treats Accept: */* as NOT accepting JSON-LD
    // (it only returns true for explicit application/activity+json etc.).
    // Remote servers fetching actor URLs for HTTP Signature verification
    // (e.g. tags.pub) often omit Accept or use */* — they get HTML back
    // instead of the actor JSON, causing "public key not found" errors.
    // Fix: for GET requests to actor paths, upgrade ambiguous Accept headers
    // to application/activity+json so Fedify serves JSON-LD. Explicit
    // text/html requests (browsers) are unaffected.
    if (req.method === "GET" && /^\/users\/[^/]+\/?$/.test(req.path)) {
      const accept = req.get("accept") || "";
      if (!accept.includes("text/html") && !accept.includes("application/xhtml+xml")) {
        req.headers["accept"] = "application/activity+json";
      }
    }

    return self._fedifyMiddleware(req, res, next);
  });

  // Authorize interaction — remote follow / subscribe endpoint.
  // Remote servers redirect users here via the WebFinger subscribe template.
  router.get("/authorize_interaction", authorizeInteractionController(self));

  // HTML fallback for actor URL — serve a public profile page.
  // Fedify only serves JSON-LD; browsers get 406 and fall through here.
  router.get("/users/:identifier", publicProfileController(self));

  // Catch-all for federation paths that Fedify didn't handle (e.g. GET
  // on inbox). Without this, they fall through to Indiekit's auth
  // middleware and redirect to the login page.
  router.all("/users/:identifier/inbox", (req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .type("application/activity+json")
      .json({
        error: "Method Not Allowed",
        message: "The inbox only accepts POST requests",
      });
  });
  router.all("/inbox", (req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .type("application/activity+json")
      .json({
        error: "Method Not Allowed",
        message: "The shared inbox only accepts POST requests",
      });
  });

  return router;
}

/**
 * Content negotiation — serves AS2 JSON for ActivityPub clients requesting
 * individual post URLs; delegates /nodeinfo/2.1 to Fedify.
 * @param {object} self - the ActivityPubEndpoint instance
 * @returns {import("express").Router}
 */
export function buildContentNegotiationRoutes(self) {
  const router = express.Router(); // eslint-disable-line new-cap

  // Let Fedify handle NodeInfo data (/nodeinfo/2.1)
  // Only pass GET/HEAD requests — POST/PUT/DELETE must not go through
  // Fedify here, because fromExpressRequest() consumes the body stream,
  // breaking Express body-parsed routes downstream (e.g. admin forms).
  router.use((req, res, next) => {
    if (!self._fedifyMiddleware) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // Only delegate to Fedify for NodeInfo data endpoint (/nodeinfo/2.1).
    // All other paths in this root-mounted router are handled by the
    // content negotiation catch-all below. Passing arbitrary paths like
    // /notes/... to Fedify causes harmless but noisy 404 warnings.
    if (!req.path.startsWith("/nodeinfo/")) return next();
    return self._fedifyMiddleware(req, res, next);
  });

  // Content negotiation for AP clients on regular URLs
  router.get("{*path}", async (req, res, next) => {
    const accept = req.headers.accept || "";
    const isActivityPub =
      accept.includes("application/activity+json") ||
      accept.includes("application/ld+json");

    if (!isActivityPub) {
      return next();
    }

    try {
      // Root URL — redirect to Fedify actor
      if (req.path === "/") {
        const actorPath = `${self.options.mountPath}/users/${self.options.actor.handle}`;
        return res.redirect(actorPath);
      }

      // Post URLs — look up in database and convert to AS2
      const { application } = req.app.locals;
      const postsCollection = application?.collections?.get("posts");
      if (!postsCollection) {
        return next();
      }

      // Match regardless of trailing slash: posts are stored without one, but
      // AS2 dereference requests (and nginx AS2 proxy passthrough) can arrive
      // with a trailing slash. Try both so content negotiation stays robust.
      const requestUrl = `${self._publicationUrl}${req.path.slice(1)}`;
      const requestUrlNoSlash = requestUrl.replace(/\/$/, "");
      const post = await postsCollection.findOne({
        "properties.url": { $in: [requestUrlNoSlash, `${requestUrlNoSlash}/`] },
      });

      if (!post || post.properties?.deleted) {
        // FEP-4f05: Serve Tombstone for deleted posts
        const { getTombstone } = await import("../storage/tombstones.js");
        const tombstone = await getTombstone(self._collections, requestUrl);
        if (tombstone) {
          res.status(410).set("Content-Type", "application/activity+json").json({
            "@context": "https://www.w3.org/ns/activitystreams",
            type: "Tombstone",
            id: requestUrl,
            formerType: tombstone.formerType,
            published: tombstone.published || undefined,
            deleted: tombstone.deleted,
          });
          return;
        }
        return next();
      }

      const actorUrl = self._getActorUrl();
      const activity = jf2ToActivityStreams(
        post.properties,
        actorUrl,
        self._publicationUrl,
        { visibility: self.options.defaultVisibility },
      );

      const object = activity.object || activity;
      res.set("Content-Type", "application/activity+json");
      return res.json({
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          "https://w3id.org/security/v1",
        ],
        ...object,
      });
    } catch {
      return next();
    }
  });

  return router;
}
