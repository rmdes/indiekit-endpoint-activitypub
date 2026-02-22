/**
 * Like/Unlike interaction controllers.
 * Sends Like and Undo(Like) activities via Fedify.
 */

import { validateToken } from "../csrf.js";

/**
 * POST /admin/reader/like — send a Like activity to the post author.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance (for federation access)
 */
export function likeController(mountPath, plugin) {
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

      const { Like } = await import("@fedify/fedify/vocab");
      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      // Use authenticated document loader for servers requiring Authorized Fetch
      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });

      // Resolve author for delivery — try multiple strategies
      let recipient = null;

      // Strategy 1: Look up remote post via Fedify (signed request)
      try {
        const remoteObject = await ctx.lookupObject(new URL(url), {
          documentLoader,
        });
        if (remoteObject && typeof remoteObject.getAttributedTo === "function") {
          const author = await remoteObject.getAttributedTo({ documentLoader });
          recipient = Array.isArray(author) ? author[0] : author;
        }
      } catch (error) {
        console.warn(
          `[ActivityPub] lookupObject failed for ${url}:`,
          error.message,
        );
      }

      // Strategy 2: Use author URL from our timeline (already stored)
      // Note: Timeline items store both uid (canonical AP URL) and url (display URL).
      // The card passes the display URL, so we search by both fields.
      if (!recipient) {
        const { application } = request.app.locals;
        const ap_timeline = application?.collections?.get("ap_timeline");
        const timelineItem = ap_timeline
          ? await ap_timeline.findOne({ $or: [{ uid: url }, { url }] })
          : null;
        const authorUrl = timelineItem?.author?.url;

        if (authorUrl) {
          try {
            recipient = await ctx.lookupObject(new URL(authorUrl), {
              documentLoader,
            });
          } catch {
            // Could not resolve author actor either
          }
        }

        if (!recipient) {
          return response.status(404).json({
            success: false,
            error: "Could not resolve post author",
          });
        }
      }

      // Generate a unique activity ID
      const uuid = crypto.randomUUID();
      const baseUrl = plugin._publicationUrl.replace(/\/$/, "");
      const activityId = `${baseUrl}/activitypub/likes/${uuid}`;

      // Construct and send Like activity
      const like = new Like({
        id: new URL(activityId),
        actor: ctx.getActorUri(handle),
        object: new URL(url),
      });

      await ctx.sendActivity({ identifier: handle }, recipient, like, {
        orderingKey: url,
      });

      // Track the interaction for undo
      const { application } = request.app.locals;
      const interactions = application?.collections?.get("ap_interactions");

      if (interactions) {
        await interactions.updateOne(
          { objectUrl: url, type: "like" },
          {
            $set: {
              objectUrl: url,
              type: "like",
              activityId,
              recipientUrl: recipient.id?.href || "",
              createdAt: new Date().toISOString(),
            },
          },
          { upsert: true },
        );
      }

      console.info(`[ActivityPub] Sent Like for ${url}`);

      return response.json({
        success: true,
        type: "like",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Like failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Like failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unlike — send an Undo(Like) activity.
 */
export function unlikeController(mountPath, plugin) {
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

      // Look up the original interaction to get the activity ID
      const existing = interactions
        ? await interactions.findOne({ objectUrl: url, type: "like" })
        : null;

      if (!existing) {
        return response.status(404).json({
          success: false,
          error: "No like found for this post",
        });
      }

      const { Like, Undo } = await import("@fedify/fedify/vocab");
      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      // Use authenticated document loader for servers requiring Authorized Fetch
      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });

      // Resolve the recipient — try remote first, then timeline fallback
      let recipient = null;

      try {
        const remoteObject = await ctx.lookupObject(new URL(url), {
          documentLoader,
        });
        if (remoteObject && typeof remoteObject.getAttributedTo === "function") {
          const author = await remoteObject.getAttributedTo({ documentLoader });
          recipient = Array.isArray(author) ? author[0] : author;
        }
      } catch (error) {
        console.warn(
          `[ActivityPub] lookupObject failed for ${url} (unlike):`,
          error.message,
        );
      }

      if (!recipient) {
        const ap_timeline = application?.collections?.get("ap_timeline");
        const timelineItem = ap_timeline
          ? await ap_timeline.findOne({ $or: [{ uid: url }, { url }] })
          : null;
        const authorUrl = timelineItem?.author?.url;

        if (authorUrl) {
          try {
            recipient = await ctx.lookupObject(new URL(authorUrl), {
              documentLoader,
            });
          } catch {
            // Could not resolve — will proceed to cleanup
          }
        }
      }

      if (!recipient) {
        // Clean up the local record even if we can't send Undo
        if (interactions) {
          await interactions.deleteOne({ objectUrl: url, type: "like" });
        }

        return response.json({
          success: true,
          type: "unlike",
          objectUrl: url,
        });
      }

      // Construct Undo(Like)
      const like = new Like({
        id: existing.activityId ? new URL(existing.activityId) : undefined,
        actor: ctx.getActorUri(handle),
        object: new URL(url),
      });

      const undo = new Undo({
        actor: ctx.getActorUri(handle),
        object: like,
      });

      await ctx.sendActivity({ identifier: handle }, recipient, undo, {
        orderingKey: url,
      });

      // Remove the interaction record
      if (interactions) {
        await interactions.deleteOne({ objectUrl: url, type: "like" });
      }

      console.info(`[ActivityPub] Sent Undo(Like) for ${url}`);

      return response.json({
        success: true,
        type: "unlike",
        objectUrl: url,
      });
    } catch (error) {
      console.error("[ActivityPub] Unlike failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Unlike failed. Please try again later.",
      });
    }
  };
}
