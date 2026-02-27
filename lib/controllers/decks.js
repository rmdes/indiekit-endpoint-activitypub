/**
 * Deck CRUD controller — manages favorited instance deck entries.
 * Stored in the ap_decks MongoDB collection.
 */

import { validateToken } from "../csrf.js";
import { validateInstance } from "./explore.js";

const MAX_DECKS = 8;

/**
 * GET /admin/reader/api/decks
 * Returns all deck entries sorted by addedAt ascending.
 */
export function listDecksController(_mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_decks");
      if (!collection) {
        return response.json([]);
      }

      const decks = await collection
        .find({}, { projection: { _id: 0 } })
        .sort({ addedAt: 1 })
        .toArray();

      return response.json(decks);
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * POST /admin/reader/api/decks
 * Adds a new deck entry for the given domain + scope.
 * Body: { domain, scope }
 */
export function addDeckController(_mountPath) {
  return async (request, response, next) => {
    try {
      // CSRF protection
      if (!validateToken(request)) {
        return response.status(403).json({ error: "Invalid CSRF token" });
      }

      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_decks");
      if (!collection) {
        return response.status(500).json({ error: "Deck storage unavailable" });
      }

      const { domain: rawDomain, scope: rawScope } = request.body;

      // Validate domain (SSRF prevention)
      const domain = validateInstance(rawDomain);
      if (!domain) {
        return response.status(400).json({ error: "Invalid instance domain" });
      }

      // Validate scope
      const scope = rawScope === "federated" ? "federated" : "local";

      // Enforce max deck limit
      const count = await collection.countDocuments();
      if (count >= MAX_DECKS) {
        return response.status(400).json({
          error: `Maximum of ${MAX_DECKS} decks reached`,
        });
      }

      // Insert (unique index on domain+scope will throw on duplicate)
      const deck = {
        domain,
        scope,
        addedAt: new Date().toISOString(),
      };

      try {
        await collection.insertOne(deck);
      } catch (insertError) {
        if (insertError.code === 11_000) {
          // Duplicate key — deck already exists
          return response.status(409).json({
            error: "Deck already exists for this domain and scope",
          });
        }

        throw insertError;
      }

      return response.status(201).json(deck);
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * POST /admin/reader/api/decks/remove
 * Removes the deck entry for the given domain + scope.
 * Body: { domain, scope }
 */
export function removeDeckController(_mountPath) {
  return async (request, response, next) => {
    try {
      // CSRF protection
      if (!validateToken(request)) {
        return response.status(403).json({ error: "Invalid CSRF token" });
      }

      const { application } = request.app.locals;
      const collection = application?.collections?.get("ap_decks");
      if (!collection) {
        return response.status(500).json({ error: "Deck storage unavailable" });
      }

      const { domain: rawDomain, scope: rawScope } = request.body;

      // Validate domain (SSRF prevention)
      const domain = validateInstance(rawDomain);
      if (!domain) {
        return response.status(400).json({ error: "Invalid instance domain" });
      }

      const scope = rawScope === "federated" ? "federated" : "local";

      await collection.deleteOne({ domain, scope });

      return response.json({ success: true });
    } catch (error) {
      return next(error);
    }
  };
}
