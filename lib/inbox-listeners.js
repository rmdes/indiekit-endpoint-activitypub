/**
 * Inbox listener registrations for the Fedify Federation instance.
 *
 * Each listener handles a specific ActivityPub activity type received
 * in the actor's inbox (Follow, Undo, Like, Announce, Create, Delete, Move).
 */

import {
  Accept,
  Add,
  Announce,
  Article,
  Block,
  Create,
  Delete,
  Follow,
  Like,
  Move,
  Note,
  Reject,
  Remove,
  Undo,
  Update,
} from "@fedify/fedify/vocab";

import { logActivity as logActivityShared } from "./activity-log.js";
import { sanitizeContent, extractActorInfo, extractObjectData } from "./timeline-store.js";
import { addTimelineItem, deleteTimelineItem, updateTimelineItem } from "./storage/timeline.js";
import { addNotification } from "./storage/notifications.js";
import { fetchAndStorePreviews } from "./og-unfurl.js";

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

  /**
   * Get an authenticated DocumentLoader that signs outbound fetches with
   * our actor's key. This allows .getActor()/.getObject() to succeed
   * against Authorized Fetch (Secure Mode) servers like hachyderm.io.
   *
   * @param {import("@fedify/fedify").Context} ctx - Fedify context
   * @returns {Promise<import("@fedify/fedify").DocumentLoader>}
   */
  const getAuthLoader = (ctx) => ctx.getDocumentLoader({ identifier: handle });

  inboxChain
    .on(Follow, async (ctx, follow) => {
      const authLoader = await getAuthLoader(ctx);
      const followerActor = await follow.getActor({ documentLoader: authLoader });
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
        { orderingKey: followerUrl },
      );

      await logActivity(collections, storeRawActivities, {
        direction: "inbound",
        type: "Follow",
        actorUrl: followerUrl,
        actorName: followerName,
        summary: `${followerName} followed you`,
      });

      // Store notification
      const followerInfo = await extractActorInfo(followerActor, { documentLoader: authLoader });
      await addNotification(collections, {
        uid: follow.id?.href || `follow:${followerUrl}`,
        type: "follow",
        actorUrl: followerInfo.url,
        actorName: followerInfo.name,
        actorPhoto: followerInfo.photo,
        actorHandle: followerInfo.handle,
        published: follow.published ? String(follow.published) : new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    })
    .on(Undo, async (ctx, undo) => {
      const actorUrl = undo.actorId?.href || "";
      const authLoader = await getAuthLoader(ctx);
      let inner;
      try {
        inner = await undo.getObject({ documentLoader: authLoader });
      } catch {
        // Inner activity not dereferenceable — can't determine what was undone
        return;
      }

      if (inner instanceof Follow) {
        await collections.ap_followers.deleteOne({ actorUrl });
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Undo(Follow)",
          actorUrl,
          summary: `${actorUrl} unfollowed you`,
        });
      } else if (inner instanceof Like) {
        const objectId = inner.objectId?.href || "";
        await collections.ap_activities.deleteOne({
          type: "Like",
          actorUrl,
          objectUrl: objectId,
        });
      } else if (inner instanceof Announce) {
        const objectId = inner.objectId?.href || "";
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
    .on(Accept, async (ctx, accept) => {
      // Handle Accept(Follow) — remote server accepted our Follow request.
      // We don't inspect the inner object type because Fedify often resolves
      // it to a Person (the Follow's target) rather than the Follow itself.
      // Instead, we match directly against ap_following — if we have a
      // pending follow for this actor, any Accept from them confirms it.
      const authLoader = await getAuthLoader(ctx);
      const actorObj = await accept.getActor({ documentLoader: authLoader });
      const actorUrl = actorObj?.id?.href || "";
      if (!actorUrl) return;

      const result = await collections.ap_following.findOneAndUpdate(
        {
          actorUrl,
          source: { $in: ["refollow:sent", "reader", "microsub-reader"] },
        },
        {
          $set: {
            source: "federation",
            acceptedAt: new Date().toISOString(),
          },
          $unset: {
            refollowAttempts: "",
            refollowLastAttempt: "",
            refollowError: "",
          },
        },
        { returnDocument: "after" },
      );

      if (result) {
        const actorName =
          result.name || result.handle || actorUrl;
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Accept(Follow)",
          actorUrl,
          actorName,
          summary: `${actorName} accepted our Follow`,
        });
      }
    })
    .on(Reject, async (ctx, reject) => {
      const authLoader = await getAuthLoader(ctx);
      const actorObj = await reject.getActor({ documentLoader: authLoader });
      const actorUrl = actorObj?.id?.href || "";
      if (!actorUrl) return;

      // Mark rejected follow in ap_following
      const result = await collections.ap_following.findOneAndUpdate(
        {
          actorUrl,
          source: { $in: ["refollow:sent", "reader", "microsub-reader"] },
        },
        {
          $set: {
            source: "rejected",
            rejectedAt: new Date().toISOString(),
          },
        },
        { returnDocument: "after" },
      );

      if (result) {
        const actorName = result.name || result.handle || actorUrl;
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Reject(Follow)",
          actorUrl,
          actorName,
          summary: `${actorName} rejected our Follow`,
        });
      }
    })
    .on(Like, async (ctx, like) => {
      // Use .objectId (non-fetching) for the liked URL — we only need the
      // URL to filter and log, not the full remote object.
      const objectId = like.objectId?.href || "";

      // Only log likes of our own content
      const pubUrl = collections._publicationUrl;
      if (!objectId || (pubUrl && !objectId.startsWith(pubUrl))) return;

      const authLoader = await getAuthLoader(ctx);
      const actorUrl = like.actorId?.href || "";
      let actorObj;
      try {
        actorObj = await like.getActor({ documentLoader: authLoader });
      } catch {
        actorObj = null;
      }

      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;

      // Extract actor info (including avatar) before logging so we can store it
      const actorInfo = await extractActorInfo(actorObj, { documentLoader: authLoader });

      await logActivity(collections, storeRawActivities, {
        direction: "inbound",
        type: "Like",
        actorUrl,
        actorName,
        actorAvatar: actorInfo.photo || "",
        objectUrl: objectId,
        summary: `${actorName} liked ${objectId}`,
      });

      // Store notification
      await addNotification(collections, {
        uid: like.id?.href || `like:${actorUrl}:${objectId}`,
        type: "like",
        actorUrl: actorInfo.url,
        actorName: actorInfo.name,
        actorPhoto: actorInfo.photo,
        actorHandle: actorInfo.handle,
        targetUrl: objectId,
        targetName: "", // Could fetch post title, but not critical
        published: like.published ? String(like.published) : new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    })
    .on(Announce, async (ctx, announce) => {
      const objectId = announce.objectId?.href || "";
      if (!objectId) return;

      const authLoader = await getAuthLoader(ctx);
      const actorUrl = announce.actorId?.href || "";
      const pubUrl = collections._publicationUrl;

      // Dual path logic: Notification vs Timeline

      // PATH 1: Boost of OUR content → Notification
      if (pubUrl && objectId.startsWith(pubUrl)) {
        let actorObj;
        try {
          actorObj = await announce.getActor({ documentLoader: authLoader });
        } catch {
          actorObj = null;
        }

        const actorName =
          actorObj?.name?.toString() ||
          actorObj?.preferredUsername?.toString() ||
          actorUrl;

        // Extract actor info (including avatar) before logging so we can store it
        const actorInfo = await extractActorInfo(actorObj, { documentLoader: authLoader });

        // Log the boost activity
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Announce",
          actorUrl,
          actorName,
          actorAvatar: actorInfo.photo || "",
          objectUrl: objectId,
          summary: `${actorName} boosted ${objectId}`,
        });

        // Create notification
        await addNotification(collections, {
          uid: announce.id?.href || `${actorUrl}#boost-${objectId}`,
          type: "boost",
          actorUrl: actorInfo.url,
          actorName: actorInfo.name,
          actorPhoto: actorInfo.photo,
          actorHandle: actorInfo.handle,
          targetUrl: objectId,
          targetName: "", // Could fetch post title, but not critical
          published: announce.published ? String(announce.published) : new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });

        // Don't return — fall through to check if actor is also followed
      }

      // PATH 2: Boost from someone we follow → Timeline (store original post)
      const following = await collections.ap_following.findOne({ actorUrl });
      if (following) {
        try {
          // Fetch the original object being boosted (authenticated for Secure Mode servers)
          const object = await announce.getObject({ documentLoader: authLoader });
          if (!object) return;

          // Skip non-content objects (Lemmy/PieFed like/create activities
          // that resolve to activity IDs instead of actual Note/Article posts)
          const hasContent = object.content?.toString() || object.name?.toString();
          if (!hasContent) return;

          // Get booster actor info
          const boosterActor = await announce.getActor({ documentLoader: authLoader });
          const boosterInfo = await extractActorInfo(boosterActor, { documentLoader: authLoader });

          // Extract and store with boost metadata
          const timelineItem = await extractObjectData(object, {
            boostedBy: boosterInfo,
            boostedAt: announce.published ? String(announce.published) : new Date().toISOString(),
            documentLoader: authLoader,
          });

          await addTimelineItem(collections, timelineItem);
        } catch (error) {
          // Remote object unreachable (timeout, Authorized Fetch, deleted, etc.) — skip
          const cause = error?.cause?.code || error?.message || "unknown";
          console.warn(`[AP] Skipped boost from ${actorUrl}: ${cause}`);
        }
      }
    })
    .on(Create, async (ctx, create) => {
      const authLoader = await getAuthLoader(ctx);
      let object;
      try {
        object = await create.getObject({ documentLoader: authLoader });
      } catch {
        // Remote object not dereferenceable (deleted, etc.)
        return;
      }
      if (!object) return;

      const actorUrl = create.actorId?.href || "";
      let actorObj;
      try {
        actorObj = await create.getActor({ documentLoader: authLoader });
      } catch {
        // Actor not dereferenceable — use URL as fallback
        actorObj = null;
      }
      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;

      // Use replyTargetId (non-fetching) for the inReplyTo URL
      const inReplyTo = object.replyTargetId?.href || null;

      // Log replies to our posts (existing behavior for conversations)
      const pubUrl = collections._publicationUrl;
      if (inReplyTo) {
        const content = object.content?.toString() || "";

        // Extract actor info (including avatar) before logging so we can store it
        const actorInfo = await extractActorInfo(actorObj, { documentLoader: authLoader });

        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Reply",
          actorUrl,
          actorName,
          actorAvatar: actorInfo.photo || "",
          objectUrl: object.id?.href || "",
          targetUrl: inReplyTo,
          content,
          summary: `${actorName} replied to ${inReplyTo}`,
        });

        // Create notification if reply is to one of OUR posts
        if (pubUrl && inReplyTo.startsWith(pubUrl)) {
          const rawHtml = object.content?.toString() || "";
          const contentHtml = sanitizeContent(rawHtml);
          const contentText = rawHtml.replace(/<[^>]*>/g, "").substring(0, 200);

          await addNotification(collections, {
            uid: object.id?.href || `reply:${actorUrl}:${inReplyTo}`,
            type: "reply",
            actorUrl: actorInfo.url,
            actorName: actorInfo.name,
            actorPhoto: actorInfo.photo,
            actorHandle: actorInfo.handle,
            targetUrl: inReplyTo,
            targetName: "",
            content: {
              text: contentText,
              html: contentHtml,
            },
            published: object.published ? String(object.published) : new Date().toISOString(),
            createdAt: new Date().toISOString(),
          });
        }
      }

      // Check for mentions of our actor
      if (object.tag) {
        const tags = Array.isArray(object.tag) ? object.tag : [object.tag];
        const ourActorUrl = ctx.getActorUri(handle).href;

        for (const tag of tags) {
          if (tag.type === "Mention" && tag.href?.href === ourActorUrl) {
            const actorInfo = await extractActorInfo(actorObj, { documentLoader: authLoader });
            const rawMentionHtml = object.content?.toString() || "";
            const mentionHtml = sanitizeContent(rawMentionHtml);
            const contentText = rawMentionHtml.replace(/<[^>]*>/g, "").substring(0, 200);

            await addNotification(collections, {
              uid: object.id?.href || `mention:${actorUrl}:${object.id?.href}`,
              type: "mention",
              actorUrl: actorInfo.url,
              actorName: actorInfo.name,
              actorPhoto: actorInfo.photo,
              actorHandle: actorInfo.handle,
              content: {
                text: contentText,
                html: mentionHtml,
              },
              published: object.published ? String(object.published) : new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });

            break; // Only create one mention notification per post
          }
        }
      }

      // Store timeline items from accounts we follow (native storage)
      const following = await collections.ap_following.findOne({ actorUrl });
      if (following) {
        try {
          const timelineItem = await extractObjectData(object, {
            actorFallback: actorObj,
            documentLoader: authLoader,
          });
          await addTimelineItem(collections, timelineItem);

          // Fire-and-forget OG unfurling for notes and articles (not boosts)
          if (timelineItem.type === "note" || timelineItem.type === "article") {
            fetchAndStorePreviews(collections, timelineItem.uid, timelineItem.content.html)
              .catch((error) => {
                console.error(`[inbox] OG unfurl failed for ${timelineItem.uid}:`, error);
              });
          }
        } catch (error) {
          // Log extraction errors but don't fail the entire handler
          console.error("Failed to store timeline item:", error);
        }
      }

    })
    .on(Delete, async (ctx, del) => {
      const objectId = del.objectId?.href || "";
      if (objectId) {
        // Remove from activity log
        await collections.ap_activities.deleteMany({ objectUrl: objectId });

        // Remove from timeline
        await deleteTimelineItem(collections, objectId);
      }
    })
    .on(Move, async (ctx, move) => {
      const authLoader = await getAuthLoader(ctx);
      const oldActorObj = await move.getActor({ documentLoader: authLoader });
      const oldActorUrl = oldActorObj?.id?.href || "";
      const target = await move.getTarget({ documentLoader: authLoader });
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
    })
    .on(Update, async (ctx, update) => {
      // Update can be for a profile OR for a post (edited content)
      const authLoader = await getAuthLoader(ctx);

      // Try to get the object being updated
      let object;
      try {
        object = await update.getObject({ documentLoader: authLoader });
      } catch {
        object = null;
      }

      // PATH 1: If object is a Note/Article → Update timeline item content
      if (object && (object instanceof Note || object instanceof Article)) {
        const objectUrl = object.id?.href || "";
        if (objectUrl) {
          try {
            // Extract updated content
            const contentHtml = object.content?.toString() || "";
            const contentText = object.source?.content?.toString() || contentHtml.replace(/<[^>]*>/g, "");

            const updates = {
              content: {
                text: contentText,
                html: contentHtml,
              },
              name: object.name?.toString() || "",
              summary: object.summary?.toString() || "",
              sensitive: object.sensitive || false,
            };

            await updateTimelineItem(collections, objectUrl, updates);
          } catch (error) {
            console.error("Failed to update timeline item:", error);
          }
        }
        return;
      }

      // PATH 2: Otherwise, assume profile update — refresh stored follower data
      const actorObj = await update.getActor({ documentLoader: authLoader });
      const actorUrl = actorObj?.id?.href || "";
      if (!actorUrl) return;

      const existing = await collections.ap_followers.findOne({ actorUrl });
      if (existing) {
        await collections.ap_followers.updateOne(
          { actorUrl },
          {
            $set: {
              name:
                actorObj.name?.toString() ||
                actorObj.preferredUsername?.toString() ||
                actorUrl,
              handle: actorObj.preferredUsername?.toString() || "",
              avatar: actorObj.icon
                ? (await actorObj.icon)?.url?.href || ""
                : "",
              updatedAt: new Date().toISOString(),
            },
          },
        );
      }
    })
    .on(Block, async (ctx, block) => {
      // Remote actor blocked us — remove them from followers
      const authLoader = await getAuthLoader(ctx);
      const actorObj = await block.getActor({ documentLoader: authLoader });
      const actorUrl = actorObj?.id?.href || "";
      if (actorUrl) {
        await collections.ap_followers.deleteOne({ actorUrl });
      }
    })
    .on(Add, async () => {
      // Mastodon uses Add for pinning posts to featured collections — safe to ignore
    })
    .on(Remove, async () => {
      // Mastodon uses Remove for unpinning posts from featured collections — safe to ignore
    });
}

/**
 * Log an activity to the ap_activities collection.
 * Wrapper around the shared utility that accepts the (collections, storeRaw, record) signature
 * used throughout this file.
 */
async function logActivity(collections, storeRaw, record, rawJson) {
  await logActivityShared(
    collections.ap_activities,
    record,
    storeRaw && rawJson ? { rawJson } : {},
  );
}

