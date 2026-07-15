/**
 * Inbox listener registrations for the Fedify Federation instance.
 *
 * Each listener is a thin shim that:
 * 1. Checks server-level blocks (Redis, O(1))
 * 2. Updates key freshness tracking
 * 3. Performs synchronous-only work (Follow Accept, Block follower removal)
 * 4. Enqueues the activity for async processing
 */

import {
  Accept,
  Add,
  Announce,
  Block,
  Create,
  Delete,
  Flag,
  Follow,
  Like,
  Move,
  Reject,
  Remove,
  Undo,
  Update,
} from "@fedify/vocab";

import { isServerBlocked } from "./storage/server-blocks.js";
import { touchKeyFreshness } from "./key-refresh.js";
import { resetDeliveryStrikes } from "./outbox-failure.js";
import { enqueueActivity } from "./inbox-queue.js";
import { extractActorInfo } from "./timeline-store.js";
import { addNotification } from "./storage/notifications.js";

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
  const { collections, handle } = options;

  const getAuthLoader = (ctx) => ctx.getDocumentLoader({ identifier: handle });

  inboxChain
    // ── Follow ──────────────────────────────────────────────────────
    // Synchronous: Accept/Reject + follower storage (federation requirement)
    // Async: notification + activity log
    .on(Follow, async (ctx, follow) => {
      const actorUrl = follow.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      const authLoader = await getAuthLoader(ctx);
      const followerActor = await follow.getActor({ documentLoader: authLoader });
      if (!followerActor?.id) return;

      const followerUrl = followerActor.id.href;
      const followerName =
        followerActor.name?.toString() ||
        followerActor.preferredUsername?.toString() ||
        followerUrl;

      const followerData = {
        actorUrl: followerUrl,
        handle: followerActor.preferredUsername?.toString() || "",
        name: followerName,
        avatar: followerActor.icon
          ? (await followerActor.icon)?.url?.href || ""
          : "",
        inbox: followerActor.inbox?.id?.href || "",
        sharedInbox: followerActor.endpoints?.sharedInbox?.href || "",
      };

      const profile = await collections.ap_profile.findOne({});
      const manualApproval = profile?.manuallyApprovesFollowers || false;

      if (manualApproval && collections.ap_pending_follows) {
        await collections.ap_pending_follows.updateOne(
          { actorUrl: followerUrl },
          {
            $set: {
              ...followerData,
              followActivityId: follow.id?.href || "",
              requestedAt: new Date().toISOString(),
            },
          },
          { upsert: true },
        );

        // Notification for follow request (synchronous — needed for UI)
        const followerInfo = await extractActorInfo(followerActor, { documentLoader: authLoader });
        await addNotification(collections, {
          // Dedup per ACTOR, not per Follow activity id. Some servers (e.g.
          // bonfire.cafe, whose shared_inbox 404s so our Accept never lands)
          // re-send Follow on a schedule with a fresh activity id each time;
          // keying on the id spawned a new notification every retry (39+ dupes).
          uid: `follow_request:${followerUrl}`,
          type: "follow_request",
          actorUrl: followerInfo.url,
          actorName: followerInfo.name,
          actorPhoto: followerInfo.photo,
          actorHandle: followerInfo.handle,
          published: follow.published ? String(follow.published) : new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      } else {
        await collections.ap_followers.updateOne(
          { actorUrl: followerUrl },
          {
            $set: {
              ...followerData,
              followedAt: new Date().toISOString(),
            },
          },
          { upsert: true },
        );

        await ctx.sendActivity(
          { identifier: handle },
          followerActor,
          new Accept({
            actor: ctx.getActorUri(handle),
            object: follow,
          }),
          { orderingKey: followerUrl },
        );

        // Notification for follow (synchronous — needed for UI)
        const followerInfo = await extractActorInfo(followerActor, { documentLoader: authLoader });
        await addNotification(collections, {
          // Dedup per ACTOR, not per Follow activity id — see follow_request
          // note above. A re-follow updates this one notification instead of
          // piling up duplicates in the notifications list.
          uid: `follow:${followerUrl}`,
          type: "follow",
          actorUrl: followerInfo.url,
          actorName: followerInfo.name,
          actorPhoto: followerInfo.photo,
          actorHandle: followerInfo.handle,
          published: follow.published ? String(follow.published) : new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }

      // Enqueue async portion (activity log)
      await enqueueActivity(collections, {
        activityType: "Follow",
        actorUrl,
        rawJson: await follow.toJsonLd(),
      });
    })

    // ── Undo ────────────────────────────────────────────────────────
    .on(Undo, async (ctx, undo) => {
      const actorUrl = undo.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Undo",
        actorUrl,
        rawJson: await undo.toJsonLd(),
      });
    })

    // ── Accept ──────────────────────────────────────────────────────
    .on(Accept, async (ctx, accept) => {
      const actorUrl = accept.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Accept",
        actorUrl,
        rawJson: await accept.toJsonLd(),
      });
    })

    // ── Reject ──────────────────────────────────────────────────────
    .on(Reject, async (ctx, reject) => {
      const actorUrl = reject.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Reject",
        actorUrl,
        rawJson: await reject.toJsonLd(),
      });
    })

    // ── Like ────────────────────────────────────────────────────────
    .on(Like, async (ctx, like) => {
      const actorUrl = like.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Like",
        actorUrl,
        objectUrl: like.objectId?.href || "",
        rawJson: await like.toJsonLd(),
      });
    })

    // ── Announce ────────────────────────────────────────────────────
    .on(Announce, async (ctx, announce) => {
      const actorUrl = announce.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Announce",
        actorUrl,
        objectUrl: announce.objectId?.href || "",
        rawJson: await announce.toJsonLd(),
      });
    })

    // ── Create ──────────────────────────────────────────────────────
    .on(Create, async (ctx, create) => {
      const actorUrl = create.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      // Forward public replies to our posts to our followers.
      // Must happen here (not in async handler) because forwardActivity
      // is only available on InboxContext, not base Context.
      const objectUrl = create.objectId?.href || "";
      try {
        // Authenticated loader — Secure-Mode (Authorized Fetch) servers reject
        // unsigned GETs with 401, which would silently skip reply forwarding.
        const authLoader = await getAuthLoader(ctx);
        const obj = await create.getObject({ documentLoader: authLoader });
        const inReplyTo = obj?.replyTargetId?.href || "";
        if (
          inReplyTo &&
          collections._publicationUrl &&
          inReplyTo.startsWith(collections._publicationUrl)
        ) {
          // Check if the reply is public (to/cc includes PUBLIC collection)
          const toUrls = (obj.toIds || []).map((u) => u.href);
          const ccUrls = (obj.ccIds || []).map((u) => u.href);
          const isPublic = [...toUrls, ...ccUrls].includes(
            "https://www.w3.org/ns/activitystreams#Public",
          );
          if (isPublic) {
            await ctx.forwardActivity(
              { identifier: handle },
              "followers",
              {
                skipIfUnsigned: true,
                preferSharedInbox: true,
                excludeBaseUris: [new URL(ctx.origin)],
              },
            );
          }
        }
      } catch (error) {
        // Non-critical — forwarding failure shouldn't block processing
        console.warn("[inbox-listeners] Reply forwarding failed:", error.message);
      }

      await enqueueActivity(collections, {
        activityType: "Create",
        actorUrl,
        objectUrl,
        rawJson: await create.toJsonLd(),
      });
    })

    // ── Delete ──────────────────────────────────────────────────────
    .on(Delete, async (ctx, del) => {
      const actorUrl = del.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Delete",
        actorUrl,
        objectUrl: del.objectId?.href || "",
        rawJson: await del.toJsonLd(),
      });
    })

    // ── Move ────────────────────────────────────────────────────────
    .on(Move, async (ctx, move) => {
      const actorUrl = move.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Move",
        actorUrl,
        rawJson: await move.toJsonLd(),
      });
    })

    // ── Update ──────────────────────────────────────────────────────
    .on(Update, async (ctx, update) => {
      const actorUrl = update.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Update",
        actorUrl,
        rawJson: await update.toJsonLd(),
      });
    })

    // ── Block ───────────────────────────────────────────────────────
    // Synchronous: remove from followers (immediate)
    // Async: activity log
    .on(Block, async (ctx, block) => {
      const actorUrl = block.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;

      // Synchronous: remove from followers immediately
      const authLoader = await getAuthLoader(ctx);
      const actorObj = await block.getActor({ documentLoader: authLoader });
      const resolvedUrl = actorObj?.id?.href || "";
      if (resolvedUrl) {
        await collections.ap_followers.deleteOne({ actorUrl: resolvedUrl });
      }

      await enqueueActivity(collections, {
        activityType: "Block",
        actorUrl: resolvedUrl || actorUrl,
        rawJson: await block.toJsonLd(),
      });
    })

    // ── Add / Remove (no-ops) ───────────────────────────────────────
    .on(Add, async () => {})
    .on(Remove, async () => {})

    // ── Flag ────────────────────────────────────────────────────────
    .on(Flag, async (ctx, flag) => {
      const actorUrl = flag.actorId?.href || "";
      if (await isServerBlocked(actorUrl, collections)) return;
      await touchKeyFreshness(collections, actorUrl);
      await resetDeliveryStrikes(collections, actorUrl);

      await enqueueActivity(collections, {
        activityType: "Flag",
        actorUrl,
        rawJson: await flag.toJsonLd(),
      });
    });
}
