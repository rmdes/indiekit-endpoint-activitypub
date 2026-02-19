/**
 * Inbox listener registrations for the Fedify Federation instance.
 *
 * Each listener handles a specific ActivityPub activity type received
 * in the actor's inbox (Follow, Undo, Like, Announce, Create, Delete, Move).
 */

import {
  Accept,
  Announce,
  Create,
  Delete,
  Follow,
  Like,
  Move,
  Note,
  Undo,
} from "@fedify/fedify";

/**
 * Register all inbox listeners on a federation's inbox chain.
 *
 * @param {object} inboxChain - Return value of federation.setInboxListeners()
 * @param {object} options
 * @param {object} options.collections - MongoDB collections
 * @param {string} options.handle - Actor handle
 * @param {boolean} options.storeRawActivities - Whether to store raw JSON
 */
export function registerInboxListeners(inboxChain, options) {
  const { collections, handle, storeRawActivities } = options;

  inboxChain
    .on(Follow, async (ctx, follow) => {
      const followerActor = await follow.getActor();
      if (!followerActor?.id) return;

      const followerUrl = followerActor.id.href;
      const followerName =
        followerActor.name?.toString() ||
        followerActor.preferredUsername?.toString() ||
        followerUrl;

      await collections.ap_followers.updateOne(
        { actorUrl: followerUrl },
        {
          $set: {
            actorUrl: followerUrl,
            handle: followerActor.preferredUsername?.toString() || "",
            name: followerName,
            avatar: followerActor.icon
              ? (await followerActor.icon)?.url?.href || ""
              : "",
            inbox: followerActor.inbox?.id?.href || "",
            sharedInbox: followerActor.endpoints?.sharedInbox?.href || "",
            followedAt: new Date().toISOString(),
          },
        },
        { upsert: true },
      );

      // Auto-accept: send Accept back
      await ctx.sendActivity(
        { identifier: handle },
        followerActor,
        new Accept({
          actor: ctx.getActorUri(handle),
          object: follow,
        }),
      );

      await logActivity(collections, storeRawActivities, {
        direction: "inbound",
        type: "Follow",
        actorUrl: followerUrl,
        actorName: followerName,
        summary: `${followerName} followed you`,
      });
    })
    .on(Undo, async (ctx, undo) => {
      const actorObj = await undo.getActor();
      const actorUrl = actorObj?.id?.href || "";
      const inner = await undo.getObject();

      if (inner instanceof Follow) {
        await collections.ap_followers.deleteOne({ actorUrl });
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Undo(Follow)",
          actorUrl,
          summary: `${actorUrl} unfollowed you`,
        });
      } else if (inner instanceof Like) {
        const objectId = (await inner.getObject())?.id?.href || "";
        await collections.ap_activities.deleteOne({
          type: "Like",
          actorUrl,
          objectUrl: objectId,
        });
      } else if (inner instanceof Announce) {
        const objectId = (await inner.getObject())?.id?.href || "";
        await collections.ap_activities.deleteOne({
          type: "Announce",
          actorUrl,
          objectUrl: objectId,
        });
      } else {
        const typeName = inner?.constructor?.name || "unknown";
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: `Undo(${typeName})`,
          actorUrl,
          summary: `${actorUrl} undid ${typeName}`,
        });
      }
    })
    .on(Like, async (ctx, like) => {
      const actorObj = await like.getActor();
      const actorUrl = actorObj?.id?.href || "";
      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;
      const objectId = (await like.getObject())?.id?.href || "";

      await logActivity(collections, storeRawActivities, {
        direction: "inbound",
        type: "Like",
        actorUrl,
        actorName,
        objectUrl: objectId,
        summary: `${actorName} liked ${objectId}`,
      });
    })
    .on(Announce, async (ctx, announce) => {
      const actorObj = await announce.getActor();
      const actorUrl = actorObj?.id?.href || "";
      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;
      const objectId = (await announce.getObject())?.id?.href || "";

      await logActivity(collections, storeRawActivities, {
        direction: "inbound",
        type: "Announce",
        actorUrl,
        actorName,
        objectUrl: objectId,
        summary: `${actorName} boosted ${objectId}`,
      });
    })
    .on(Create, async (ctx, create) => {
      const object = await create.getObject();
      if (!object) return;

      const inReplyTo =
        object instanceof Note
          ? (await object.getInReplyTo())?.id?.href
          : null;
      if (!inReplyTo) return;

      const actorObj = await create.getActor();
      const actorUrl = actorObj?.id?.href || "";
      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;

      await logActivity(collections, storeRawActivities, {
        direction: "inbound",
        type: "Reply",
        actorUrl,
        actorName,
        objectUrl: object.id?.href || "",
        summary: `${actorName} replied to ${inReplyTo}`,
      });
    })
    .on(Delete, async (ctx, del) => {
      const objectId = (await del.getObject())?.id?.href || "";
      if (objectId) {
        await collections.ap_activities.deleteMany({ objectUrl: objectId });
      }
    })
    .on(Move, async (ctx, move) => {
      const oldActorObj = await move.getActor();
      const oldActorUrl = oldActorObj?.id?.href || "";
      const target = await move.getTarget();
      const newActorUrl = target?.id?.href || "";

      if (oldActorUrl && newActorUrl) {
        await collections.ap_followers.updateOne(
          { actorUrl: oldActorUrl },
          { $set: { actorUrl: newActorUrl, movedFrom: oldActorUrl } },
        );
      }

      await logActivity(collections, storeRawActivities, {
        direction: "inbound",
        type: "Move",
        actorUrl: oldActorUrl,
        objectUrl: newActorUrl,
        summary: `${oldActorUrl} moved to ${newActorUrl}`,
      });
    });
}

/**
 * Log an activity to the ap_activities collection.
 */
async function logActivity(collections, storeRaw, record) {
  await collections.ap_activities.insertOne({
    ...record,
    receivedAt: new Date().toISOString(),
  });
}
