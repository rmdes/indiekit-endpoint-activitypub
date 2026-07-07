/**
 * Follow request controllers — approve and reject pending follow requests
 * when manual follow approval is enabled.
 */

import { validateToken } from "../csrf.js";
import { lookupWithSecurity } from "../lookup-helpers.js";
import { logActivity } from "../activity-log.js";
import { addNotification } from "../storage/notifications.js";
import { extractActorInfo } from "../timeline-store.js";

/**
 * POST /admin/followers/approve — Accept a pending follow request.
 */
export function approveFollowController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { actorUrl } = request.body;

      if (!actorUrl) {
        return response.status(400).json({
          success: false,
          error: "Missing actor URL",
        });
      }

      const { application } = request.app.locals;
      const pendingCol = application?.collections?.get("ap_pending_follows");
      const followersCol = application?.collections?.get("ap_followers");

      if (!pendingCol || !followersCol) {
        return response.status(503).json({
          success: false,
          error: "Collections not available",
        });
      }

      // Find the pending request
      const pending = await pendingCol.findOne({ actorUrl });
      if (!pending) {
        return response.status(404).json({
          success: false,
          error: "No pending follow request from this actor",
        });
      }

      // Move to ap_followers
      await followersCol.updateOne(
        { actorUrl },
        {
          $set: {
            actorUrl: pending.actorUrl,
            handle: pending.handle || "",
            name: pending.name || "",
            avatar: pending.avatar || "",
            inbox: pending.inbox || "",
            sharedInbox: pending.sharedInbox || "",
            followedAt: new Date().toISOString(),
          },
        },
        { upsert: true },
      );

      // Remove from pending
      await pendingCol.deleteOne({ actorUrl });

      // Send Accept(Follow) via federation
      if (plugin._federation) {
        try {
          const { Accept, Follow } = await import("@fedify/vocab");
          const handle = plugin.options.actor.handle;
          const ctx = plugin._federation.createContext(
            new URL(plugin._publicationUrl),
            { handle, publicationUrl: plugin._publicationUrl },
          );

          const documentLoader = await ctx.getDocumentLoader({
            identifier: handle,
          });

          // Resolve the remote actor for delivery
          const remoteActor = await lookupWithSecurity(ctx, new URL(actorUrl), {
            documentLoader,
          });

          if (remoteActor) {
            // Reconstruct the Follow using stored activity ID
            const followObj = new Follow({
              id: pending.followActivityId
                ? new URL(pending.followActivityId)
                : undefined,
              actor: new URL(actorUrl),
              object: ctx.getActorUri(handle),
            });

            await ctx.sendActivity(
              { identifier: handle },
              remoteActor,
              new Accept({
                actor: ctx.getActorUri(handle),
                object: followObj,
              }),
              { orderingKey: actorUrl },
            );
          }

          const activitiesCol = application?.collections?.get("ap_activities");
          if (activitiesCol) {
            await logActivity(activitiesCol, {
              direction: "outbound",
              type: "Accept(Follow)",
              actorUrl: plugin._publicationUrl,
              objectUrl: actorUrl,
              actorName: pending.name || actorUrl,
              summary: `Approved follow request from ${pending.name || actorUrl}`,
            });
          }
        } catch (error) {
          console.warn(
            `[ActivityPub] Could not send Accept to ${actorUrl}: ${error.message}`,
          );
        }
      }

      console.info(
        `[ActivityPub] Approved follow request from ${pending.name || actorUrl}`,
      );

      // Redirect back to followers page
      return response.redirect(`${mountPath}/admin/followers`);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/followers/reject — Reject a pending follow request.
 */
export function rejectFollowController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { actorUrl } = request.body;

      if (!actorUrl) {
        return response.status(400).json({
          success: false,
          error: "Missing actor URL",
        });
      }

      const { application } = request.app.locals;
      const pendingCol = application?.collections?.get("ap_pending_follows");

      if (!pendingCol) {
        return response.status(503).json({
          success: false,
          error: "Collections not available",
        });
      }

      // Find the pending request
      const pending = await pendingCol.findOne({ actorUrl });
      if (!pending) {
        return response.status(404).json({
          success: false,
          error: "No pending follow request from this actor",
        });
      }

      // Remove from pending
      await pendingCol.deleteOne({ actorUrl });

      // Send Reject(Follow) via federation
      if (plugin._federation) {
        try {
          const { Reject, Follow } = await import("@fedify/vocab");
          const handle = plugin.options.actor.handle;
          const ctx = plugin._federation.createContext(
            new URL(plugin._publicationUrl),
            { handle, publicationUrl: plugin._publicationUrl },
          );

          const documentLoader = await ctx.getDocumentLoader({
            identifier: handle,
          });

          const remoteActor = await lookupWithSecurity(ctx, new URL(actorUrl), {
            documentLoader,
          });

          if (remoteActor) {
            const followObj = new Follow({
              id: pending.followActivityId
                ? new URL(pending.followActivityId)
                : undefined,
              actor: new URL(actorUrl),
              object: ctx.getActorUri(handle),
            });

            await ctx.sendActivity(
              { identifier: handle },
              remoteActor,
              new Reject({
                actor: ctx.getActorUri(handle),
                object: followObj,
              }),
              { orderingKey: actorUrl },
            );
          }

          const activitiesCol = application?.collections?.get("ap_activities");
          if (activitiesCol) {
            await logActivity(activitiesCol, {
              direction: "outbound",
              type: "Reject(Follow)",
              actorUrl: plugin._publicationUrl,
              objectUrl: actorUrl,
              actorName: pending.name || actorUrl,
              summary: `Rejected follow request from ${pending.name || actorUrl}`,
            });
          }
        } catch (error) {
          console.warn(
            `[ActivityPub] Could not send Reject to ${actorUrl}: ${error.message}`,
          );
        }
      }

      console.info(
        `[ActivityPub] Rejected follow request from ${pending.name || actorUrl}`,
      );

      return response.redirect(`${mountPath}/admin/followers`);
    } catch (error) {
      next(error);
    }
  };
}
