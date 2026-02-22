/**
 * Boost/Unboost interaction controllers.
 * Sends Announce and Undo(Announce) activities via Fedify.
 */

import { validateToken } from "../csrf.js";

/**
 * POST /admin/reader/boost — send an Announce activity to followers.
 */
export function boostController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url } = request.body;

      if (!url) {
        return response.status(400).json({
          success: false,
          error: "Missing post URL",
        });
      }

      if (!plugin._federation) {
        return response.status(503).json({
          success: false,
          error: "Federation not initialized",
        });
      }

      const { Announce } = await import("@fedify/fedify/vocab");
      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      const activityId = `urn:uuid:${crypto.randomUUID()}`;

      // Construct Announce activity
      const announce = new Announce({
        id: new URL(activityId),
        actor: ctx.getActorUri(handle),
        object: new URL(url),
      });

      // Send to followers via shared inbox
      await ctx.sendActivity({ identifier: handle }, "followers", announce, {
        preferSharedInbox: true,
        syncCollection: true,
        orderingKey: url,
      });

      // Also send to the original post author (signed request for Authorized Fetch)
      try {
        const documentLoader = await ctx.getDocumentLoader({
          identifier: handle,
        });
        const remoteObject = await ctx.lookupObject(new URL(url), {
          documentLoader,
        });

        if (
          remoteObject &&
          typeof remoteObject.getAttributedTo === "function"
        ) {
          const author = await remoteObject.getAttributedTo({ documentLoader });
          const recipient = Array.isArray(author) ? author[0] : author;

          if (recipient) {
            await ctx.sendActivity(
              { identifier: handle },
              recipient,
              announce,
              { orderingKey: url },
            );
          }
        }
      } catch (error) {
        console.warn(
          `[ActivityPub] lookupObject failed for ${url} (boost):`,
          error.message,
        );
      }

      // Track the interaction
      const { application } = request.app.locals;
      const interactions = application?.collections?.get("ap_interactions");

      if (interactions) {
        await interactions.updateOne(
          { objectUrl: url, type: "boost" },
          {
            $set: {
              objectUrl: url,
              type: "boost",
              activityId,
              createdAt: new Date().toISOString(),
            },
          },
          { upsert: true },
        );
      }

      console.info(`[ActivityPub] Sent Announce (boost) for ${url}`);

      return response.json({
        success: true,
        type: "boost",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Boost failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Boost failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unboost — send an Undo(Announce) to followers.
 */
export function unboostController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url } = request.body;

      if (!url) {
        return response.status(400).json({
          success: false,
          error: "Missing post URL",
        });
      }

      if (!plugin._federation) {
        return response.status(503).json({
          success: false,
          error: "Federation not initialized",
        });
      }

      const { application } = request.app.locals;
      const interactions = application?.collections?.get("ap_interactions");

      const existing = interactions
        ? await interactions.findOne({ objectUrl: url, type: "boost" })
        : null;

      if (!existing) {
        return response.status(404).json({
          success: false,
          error: "No boost found for this post",
        });
      }

      const { Announce, Undo } = await import("@fedify/fedify/vocab");
      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      // Construct Undo(Announce)
      const announce = new Announce({
        id: existing.activityId ? new URL(existing.activityId) : undefined,
        actor: ctx.getActorUri(handle),
        object: new URL(url),
      });

      const undo = new Undo({
        actor: ctx.getActorUri(handle),
        object: announce,
      });

      // Send to followers
      await ctx.sendActivity({ identifier: handle }, "followers", undo, {
        preferSharedInbox: true,
        orderingKey: url,
      });

      // Remove the interaction record
      if (interactions) {
        await interactions.deleteOne({ objectUrl: url, type: "boost" });
      }

      console.info(`[ActivityPub] Sent Undo(Announce) for ${url}`);

      return response.json({
        success: true,
        type: "unboost",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Unboost failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Unboost failed. Please try again later.",
      });
    }
  };
}
