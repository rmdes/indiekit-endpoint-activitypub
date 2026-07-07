/**
 * Moderation controllers — Mute, Unmute, Block, Unblock.
 */

import { validateToken, getToken } from "../csrf.js";
import { lookupWithSecurity } from "../lookup-helpers.js";
import {
  addMuted,
  removeMuted,
  addBlocked,
  removeBlocked,
  getAllMuted,
  getAllBlocked,
  getFilterMode,
  setFilterMode,
} from "../storage/moderation.js";
import {
  addBlockedServer,
  removeBlockedServer,
  getAllBlockedServers,
} from "../storage/server-blocks.js";

/**
 * Helper to get moderation collections from request.
 */
function getModerationCollections(request) {
  const { application } = request.app.locals;
  return {
    ap_muted: application?.collections?.get("ap_muted"),
    ap_blocked: application?.collections?.get("ap_blocked"),
    ap_blocked_servers: application?.collections?.get("ap_blocked_servers"),
    ap_timeline: application?.collections?.get("ap_timeline"),
    ap_profile: application?.collections?.get("ap_profile"),
  };
}

/**
 * POST /admin/reader/mute — Mute an actor or keyword.
 */
export function muteController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url, keyword } = request.body;

      if (!url && !keyword) {
        return response.status(400).json({
          success: false,
          error: "Provide url or keyword to mute",
        });
      }

      const collections = getModerationCollections(request);
      await addMuted(collections, { url: url || undefined, keyword: keyword || undefined });

      console.info(
        `[ActivityPub] Muted ${url ? `actor: ${url}` : `keyword: ${keyword}`}`,
      );

      return response.json({
        success: true,
        type: "mute",
        url: url || undefined,
        keyword: keyword || undefined,
      });
    } catch (error) {
      console.error("[ActivityPub] Mute failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unmute — Unmute an actor or keyword.
 */
export function unmuteController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url, keyword } = request.body;

      if (!url && !keyword) {
        return response.status(400).json({
          success: false,
          error: "Provide url or keyword to unmute",
        });
      }

      const collections = getModerationCollections(request);
      await removeMuted(collections, { url: url || undefined, keyword: keyword || undefined });

      return response.json({
        success: true,
        type: "unmute",
        url: url || undefined,
        keyword: keyword || undefined,
      });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/block — Block an actor (sends Block activity + removes timeline items).
 */
export function blockController(mountPath, plugin) {
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
          error: "Missing actor URL",
        });
      }

      const collections = getModerationCollections(request);

      // Store the block
      await addBlocked(collections, url);

      // Remove timeline items from this actor
      if (collections.ap_timeline) {
        await collections.ap_timeline.deleteMany({ "author.url": url });
      }

      // Send Block activity via federation
      if (plugin._federation) {
        try {
          const { Block } = await import("@fedify/vocab");
          const handle = plugin.options.actor.handle;
          const ctx = plugin._federation.createContext(
            new URL(plugin._publicationUrl),
            { handle, publicationUrl: plugin._publicationUrl },
          );

          const documentLoader = await ctx.getDocumentLoader({
            identifier: handle,
          });
          const remoteActor = await lookupWithSecurity(ctx,new URL(url), {
            documentLoader,
          });

          if (remoteActor) {
            const block = new Block({
              actor: ctx.getActorUri(handle),
              object: new URL(url),
            });

            await ctx.sendActivity(
              { identifier: handle },
              remoteActor,
              block,
              { orderingKey: url },
            );
          }
        } catch (error) {
          console.warn(
            `[ActivityPub] Could not send Block to ${url}: ${error.message}`,
          );
        }
      }

      console.info(`[ActivityPub] Blocked actor: ${url}`);

      return response.json({
        success: true,
        type: "block",
        url,
      });
    } catch (error) {
      console.error("[ActivityPub] Block failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unblock — Unblock an actor (sends Undo(Block)).
 */
export function unblockController(mountPath, plugin) {
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
          error: "Missing actor URL",
        });
      }

      const collections = getModerationCollections(request);
      await removeBlocked(collections, url);

      // Send Undo(Block) via federation
      if (plugin._federation) {
        try {
          const { Block, Undo } = await import("@fedify/vocab");
          const handle = plugin.options.actor.handle;
          const ctx = plugin._federation.createContext(
            new URL(plugin._publicationUrl),
            { handle, publicationUrl: plugin._publicationUrl },
          );

          const documentLoader = await ctx.getDocumentLoader({
            identifier: handle,
          });
          const remoteActor = await lookupWithSecurity(ctx,new URL(url), {
            documentLoader,
          });

          if (remoteActor) {
            const block = new Block({
              actor: ctx.getActorUri(handle),
              object: new URL(url),
            });

            const undo = new Undo({
              actor: ctx.getActorUri(handle),
              object: block,
            });

            await ctx.sendActivity(
              { identifier: handle },
              remoteActor,
              undo,
              { orderingKey: url },
            );
          }
        } catch (error) {
          console.warn(
            `[ActivityPub] Could not send Undo(Block) to ${url}: ${error.message}`,
          );
        }
      }

      console.info(`[ActivityPub] Unblocked actor: ${url}`);

      return response.json({
        success: true,
        type: "unblock",
        url,
      });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/block-server — Block a server by hostname.
 */
export function blockServerController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { hostname, reason } = request.body;
      if (!hostname) {
        return response.status(400).json({
          success: false,
          error: "Missing hostname",
        });
      }

      const collections = getModerationCollections(request);
      await addBlockedServer(collections, hostname, reason);

      console.info(`[ActivityPub] Blocked server: ${hostname}`);
      return response.json({ success: true, type: "block-server", hostname });
    } catch (error) {
      console.error("[ActivityPub] Block server failed:", error.message);
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * POST /admin/reader/unblock-server — Unblock a server.
 */
export function unblockServerController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { hostname } = request.body;
      if (!hostname) {
        return response.status(400).json({
          success: false,
          error: "Missing hostname",
        });
      }

      const collections = getModerationCollections(request);
      await removeBlockedServer(collections, hostname);

      console.info(`[ActivityPub] Unblocked server: ${hostname}`);
      return response.json({ success: true, type: "unblock-server", hostname });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}

/**
 * GET /admin/reader/moderation — View muted/blocked lists.
 */
export function moderationController(mountPath) {
  return async (request, response, next) => {
    try {
      const collections = getModerationCollections(request);
      const csrfToken = getToken(request.session);

      const [muted, blocked, blockedServers, filterMode] = await Promise.all([
        getAllMuted(collections),
        getAllBlocked(collections),
        getAllBlockedServers(collections),
        getFilterMode(collections),
      ]);

      const mutedActors = muted.filter((e) => e.url);
      const mutedKeywords = muted.filter((e) => e.keyword);

      response.render("activitypub-moderation", {
        title: response.locals.__("activitypub.moderation.title"),
        readerParent: { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") },
        muted,
        blocked,
        blockedServers,
        mutedActors,
        mutedKeywords,
        filterMode,
        csrfToken,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/moderation/filter-mode — Update filter mode.
 */
export function filterModeController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { mode } = request.body;
      if (!mode || !["hide", "warn"].includes(mode)) {
        return response.status(400).json({
          success: false,
          error: 'Mode must be "hide" or "warn"',
        });
      }

      const collections = getModerationCollections(request);
      await setFilterMode(collections, mode);

      return response.json({ success: true, mode });
    } catch (error) {
      return response.status(500).json({
        success: false,
        error: "Operation failed. Please try again later.",
      });
    }
  };
}
