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
  Block,
  Create,
  Delete,
  Follow,
  Like,
  Move,
  Note,
  Remove,
  Undo,
  Update,
} from "@fedify/fedify";

import { logActivity as logActivityShared } from "./activity-log.js";

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
    .on(Accept, async (ctx, accept) => {
      // Handle Accept(Follow) — remote server accepted our Follow request.
      // We don't inspect the inner object type because Fedify often resolves
      // it to a Person (the Follow's target) rather than the Follow itself.
      // Instead, we match directly against ap_following — if we have a
      // pending follow for this actor, any Accept from them confirms it.
      const actorObj = await accept.getActor();
      const actorUrl = actorObj?.id?.href || "";
      if (!actorUrl) return;

      const result = await collections.ap_following.findOneAndUpdate(
        {
          actorUrl,
          source: { $in: ["refollow:sent", "microsub-reader"] },
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
    .on(Like, async (ctx, like) => {
      const objectId = (await like.getObject())?.id?.href || "";

      // Only log likes of our own content
      const pubUrl = collections._publicationUrl;
      if (!objectId || (pubUrl && !objectId.startsWith(pubUrl))) return;

      const actorObj = await like.getActor();
      const actorUrl = actorObj?.id?.href || "";
      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;

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
      const objectId = (await announce.getObject())?.id?.href || "";

      // Only log boosts of our own content
      const pubUrl = collections._publicationUrl;
      if (!objectId || (pubUrl && !objectId.startsWith(pubUrl))) return;

      const actorObj = await announce.getActor();
      const actorUrl = actorObj?.id?.href || "";
      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;

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

      const actorObj = await create.getActor();
      const actorUrl = actorObj?.id?.href || "";
      const actorName =
        actorObj?.name?.toString() ||
        actorObj?.preferredUsername?.toString() ||
        actorUrl;

      let inReplyTo = null;
      if (object instanceof Note && typeof object.getInReplyTo === "function") {
        try {
          inReplyTo = (await object.getInReplyTo())?.id?.href ?? null;
        } catch {
          /* remote fetch may fail */
        }
      }

      // Log replies to our posts (existing behavior for conversations)
      if (inReplyTo) {
        const content = object.content?.toString() || "";
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Reply",
          actorUrl,
          actorName,
          objectUrl: object.id?.href || "",
          targetUrl: inReplyTo,
          content,
          summary: `${actorName} replied to ${inReplyTo}`,
        });
      }

      // Store timeline items from accounts we follow
      await storeTimelineItem(collections, {
        actorUrl,
        actorName,
        actorObj,
        object,
        inReplyTo,
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
    })
    .on(Update, async (ctx, update) => {
      // Remote actor updated their profile — refresh stored follower data
      const actorObj = await update.getActor();
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
      const actorObj = await block.getActor();
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
async function logActivity(collections, storeRaw, record) {
  await logActivityShared(collections.ap_activities, record);
}

// Cached ActivityPub channel ObjectId
let _apChannelId = null;

/**
 * Look up the ActivityPub channel's ObjectId (cached after first call).
 * @param {object} collections - MongoDB collections
 * @returns {Promise<import("mongodb").ObjectId|null>}
 */
async function getApChannelId(collections) {
  if (_apChannelId) return _apChannelId;
  const channel = await collections.microsub_channels?.findOne({
    uid: "activitypub",
  });
  _apChannelId = channel?._id || null;
  return _apChannelId;
}

/**
 * Store a Create activity as a Microsub timeline item if the actor
 * is someone we follow. Skips gracefully if the Microsub plugin
 * isn't loaded or the AP channel doesn't exist yet.
 *
 * @param {object} collections - MongoDB collections
 * @param {object} params
 * @param {string} params.actorUrl - Actor URL
 * @param {string} params.actorName - Actor display name
 * @param {object} params.actorObj - Fedify actor object
 * @param {object} params.object - Fedify Note/Article object
 * @param {string|null} params.inReplyTo - URL this is a reply to (if any)
 */
async function storeTimelineItem(
  collections,
  { actorUrl, actorName, actorObj, object, inReplyTo },
) {
  // Skip if Microsub plugin not loaded
  if (!collections.microsub_items || !collections.microsub_channels) return;

  // Only store posts from accounts we follow
  const following = await collections.ap_following.findOne({ actorUrl });
  if (!following) return;

  const channelId = await getApChannelId(collections);
  if (!channelId) return;

  const objectUrl = object.id?.href || "";
  if (!objectUrl) return;

  // Extract content
  const contentHtml = object.content?.toString() || "";
  const contentText = contentHtml.replace(/<[^>]*>/g, "").trim();

  // Name (usually only on Article, not Note)
  const name = object.name?.toString() || undefined;
  const summary = object.summary?.toString() || undefined;

  // Published date — Fedify returns Temporal.Instant
  let published;
  if (object.published) {
    try {
      published = new Date(Number(object.published.epochMilliseconds));
    } catch {
      published = new Date();
    }
  }

  // Author avatar
  let authorPhoto = "";
  try {
    if (actorObj.icon) {
      const iconObj = await actorObj.icon;
      authorPhoto = iconObj?.url?.href || "";
    }
  } catch {
    /* remote fetch may fail */
  }

  // Tags / categories
  const category = [];
  try {
    for await (const tag of object.getTags()) {
      const tagName = tag.name?.toString();
      if (tagName) category.push(tagName.replace(/^#/, ""));
    }
  } catch {
    /* ignore */
  }

  // Attachments (photos, videos, audio)
  const photo = [];
  const video = [];
  const audio = [];
  try {
    for await (const att of object.getAttachments()) {
      const mediaType = att.mediaType?.toString() || "";
      const url = att.url?.href || att.id?.href || "";
      if (!url) continue;
      if (mediaType.startsWith("image/")) photo.push(url);
      else if (mediaType.startsWith("video/")) video.push(url);
      else if (mediaType.startsWith("audio/")) audio.push(url);
    }
  } catch {
    /* ignore */
  }

  const item = {
    channelId,
    feedId: null,
    uid: objectUrl,
    type: "entry",
    url: objectUrl,
    name,
    content: contentHtml ? { text: contentText, html: contentHtml } : undefined,
    summary,
    published: published || new Date(),
    author: {
      name: actorName,
      url: actorUrl,
      photo: authorPhoto,
    },
    category,
    photo,
    video,
    audio,
    inReplyTo: inReplyTo ? [inReplyTo] : [],
    source: {
      type: "activitypub",
      actorUrl,
    },
    readBy: [],
    createdAt: new Date().toISOString(),
  };

  // Atomic upsert — prevents duplicates without a separate check+insert
  await collections.microsub_items.updateOne(
    { channelId, uid: objectUrl },
    { $setOnInsert: item },
    { upsert: true },
  );
}
