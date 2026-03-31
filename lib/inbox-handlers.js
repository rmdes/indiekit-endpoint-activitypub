/**
 * Inbox handler functions for each ActivityPub activity type.
 *
 * These handlers are extracted from inbox-listeners.js so they can be
 * invoked from a background queue processor. Each handler receives a
 * queue item document instead of a live Fedify activity object.
 *
 * Design notes:
 * - Follow handler: only logs activity. Follower storage, Accept/Reject
 *   response, pending follow storage, and notifications are all handled
 *   synchronously in the inbox listener before the item is enqueued.
 * - Block handler: only logs activity. Follower removal is done
 *   synchronously in the inbox listener.
 * - All other handlers: perform full processing.
 */

import {
  Accept,
  Announce,
  Article,
  Block,
  Create,
  Delete,
  Flag,
  Follow,
  Like,
  Move,
  Note,
  Reject,
  Undo,
  Update,
} from "@fedify/fedify/vocab";

import { logActivity as logActivityShared } from "./activity-log.js";
import { sanitizeContent, extractActorInfo, extractObjectData } from "./timeline-store.js";
import { addTimelineItem, deleteTimelineItem, updateTimelineItem } from "./storage/timeline.js";
import { addNotification } from "./storage/notifications.js";
import { addMessage } from "./storage/messages.js";
import { fetchAndStorePreviews, fetchAndStoreQuote } from "./og-unfurl.js";
import { getFollowedTags } from "./storage/followed-tags.js";
import { getSettings } from "./settings.js";

/** @type {string} ActivityStreams Public Collection constant */
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route a queued inbox item to the appropriate handler.
 *
 * @param {object} item - Queue document
 * @param {string} item.activityType - Activity type name (e.g. "Follow")
 * @param {string} item.actorUrl - Actor URL
 * @param {string} [item.objectUrl] - Object URL (if applicable)
 * @param {object} item.rawJson - Raw JSON-LD activity payload
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Local actor handle
 */
export async function routeToHandler(item, collections, ctx, handle) {
  const { activityType } = item;
  switch (activityType) {
    case "Follow":
      return handleFollow(item, collections);
    case "Undo":
      return handleUndo(item, collections, ctx, handle);
    case "Accept":
      return handleAccept(item, collections, ctx, handle);
    case "Reject":
      return handleReject(item, collections, ctx, handle);
    case "Like":
      return handleLike(item, collections, ctx, handle);
    case "Announce":
      return handleAnnounce(item, collections, ctx, handle);
    case "Create":
      return handleCreate(item, collections, ctx, handle);
    case "Delete":
      return handleDelete(item, collections);
    case "Move":
      return handleMove(item, collections, ctx, handle);
    case "Update":
      return handleUpdate(item, collections, ctx, handle);
    case "Block":
      return handleBlock(item, collections);
    case "Flag":
      return handleFlag(item, collections, ctx, handle);
    default:
      console.warn(`[inbox-handlers] Unknown activity type: ${activityType}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get an authenticated DocumentLoader that signs outbound fetches with
 * our actor's key.
 *
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 * @returns {Promise<import("@fedify/fedify").DocumentLoader>}
 */
function getAuthLoader(ctx, handle) {
  return ctx.getDocumentLoader({ identifier: handle });
}

/**
 * Log an activity to the ap_activities collection.
 *
 * @param {object} collections - MongoDB collections
 * @param {object} record - Activity record fields
 */
async function logActivity(collections, record) {
  await logActivityShared(collections.ap_activities, record, {});
}

// ---------------------------------------------------------------------------
// isDirectMessage
// ---------------------------------------------------------------------------

/**
 * Determine if an object is a direct message (DM).
 * A DM is addressed only to specific actors — no PUBLIC_COLLECTION,
 * no followers collection, and includes our actor URL.
 *
 * Duplicated from inbox-listeners.js (not exported there).
 *
 * @param {object} object - Fedify object (Note, Article, etc.)
 * @param {string} ourActorUrl - Our actor's URL
 * @param {string} followersUrl - Our followers collection URL
 * @returns {boolean}
 */
function isDirectMessage(object, ourActorUrl, followersUrl) {
  const allAddressed = [
    ...object.toIds.map((u) => u.href),
    ...object.ccIds.map((u) => u.href),
    ...object.btoIds.map((u) => u.href),
    ...object.bccIds.map((u) => u.href),
  ];

  // Must be addressed to us
  if (!allAddressed.includes(ourActorUrl)) return false;

  // Must NOT include public collection
  if (allAddressed.some((u) => u === PUBLIC || u === "as:Public")) return false;

  // Must NOT include our followers collection
  if (followersUrl && allAddressed.includes(followersUrl)) return false;

  return true;
}

/**
 * Compute post visibility from to/cc addressing fields.
 * Matches Hollo's write-time visibility classification.
 *
 * @param {object} object - Fedify object (Note, Article, etc.)
 * @returns {"public"|"unlisted"|"private"|"direct"}
 */
function computeVisibility(object) {
  const to = new Set((object.toIds || []).map((u) => u.href));
  const cc = new Set((object.ccIds || []).map((u) => u.href));

  if (to.has(PUBLIC)) return "public";
  if (cc.has(PUBLIC)) return "unlisted";
  // Without knowing the remote actor's followers URL, we can't distinguish
  // "private" (followers-only) from "direct". Both are non-public.
  if (to.size > 0 || cc.size > 0) return "private";
  return "direct";
}

/**
 * Recursively fetch and store ancestor posts for a reply chain.
 * Each ancestor is stored with isContext: true so it can be filtered
 * from the main timeline while being available for thread views.
 *
 * @param {object} object - Fedify object (Note, Article, etc.)
 * @param {object} collections - MongoDB collections
 * @param {object} authLoader - Authenticated document loader
 * @param {number} maxDepth - Maximum recursion depth
 */
async function fetchReplyChain(object, collections, authLoader, maxDepth) {
  if (maxDepth <= 0) return;
  const parentUrl = object.replyTargetId?.href;
  if (!parentUrl) return;

  // Skip if we already have this post
  if (collections.ap_timeline) {
    const existing = await collections.ap_timeline.findOne({ uid: parentUrl });
    if (existing) return;
  }

  // Fetch the parent post
  let parent;
  try {
    parent = await object.getReplyTarget({ documentLoader: authLoader });
  } catch {
    // Remote server unreachable — stop climbing
    return;
  }
  if (!parent || !parent.id) return;

  // Store as context item
  try {
    const timelineItem = await extractObjectData(parent, {
      documentLoader: authLoader,
    });
    timelineItem.isContext = true;
    timelineItem.visibility = computeVisibility(parent);
    await addTimelineItem(collections, timelineItem);
  } catch {
    // Extraction failed — stop climbing
    return;
  }

  // Recurse for the parent's parent
  await fetchReplyChain(parent, collections, authLoader, maxDepth - 1);
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

/**
 * Handle Follow activity.
 *
 * The synchronous inbox listener already handled:
 *   - follower storage (or pending follow storage)
 *   - Accept/Reject response
 *   - notification creation
 *
 * This async handler only logs the activity.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 */
export async function handleFollow(item, collections) {
  await logActivity(collections, {
    direction: "inbound",
    type: "Follow",
    actorUrl: item.actorUrl,
    summary: `${item.actorUrl} follow activity processed`,
  });
}

/**
 * Handle Undo activity.
 *
 * Undoes a Follow, Like, or Announce depending on the inner object type.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleUndo(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);
  const actorUrl = item.actorUrl;

  let undo;
  try {
    undo = await Undo.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Undo from rawJson:", error.message);
    return;
  }

  let inner;
  try {
    inner = await undo.getObject({ documentLoader: authLoader });
  } catch {
    // Inner activity not dereferenceable — can't determine what was undone
    return;
  }

  if (inner instanceof Follow) {
    await collections.ap_followers.deleteOne({ actorUrl });
    await logActivity(collections, {
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
    await logActivity(collections, {
      direction: "inbound",
      type: `Undo(${typeName})`,
      actorUrl,
      summary: `${actorUrl} undid ${typeName}`,
    });
  }
}

/**
 * Handle Accept activity.
 *
 * Marks a pending follow in ap_following as accepted ("federation").
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleAccept(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);

  let accept;
  try {
    accept = await Accept.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Accept from rawJson:", error.message);
    return;
  }

  // We match against ap_following rather than inspecting the inner object
  // because Fedify often resolves the Follow's target to a Person instead
  // of the Follow itself. Any Accept from this actor confirms our pending follow.
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
    const actorName = result.name || result.handle || actorUrl;
    await logActivity(collections, {
      direction: "inbound",
      type: "Accept(Follow)",
      actorUrl,
      actorName,
      summary: `${actorName} accepted our Follow`,
    });
  }
}

/**
 * Handle Reject activity.
 *
 * Marks a pending follow in ap_following as rejected.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleReject(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);

  let reject;
  try {
    reject = await Reject.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Reject from rawJson:", error.message);
    return;
  }

  const actorObj = await reject.getActor({ documentLoader: authLoader });
  const actorUrl = actorObj?.id?.href || "";
  if (!actorUrl) return;

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
    await logActivity(collections, {
      direction: "inbound",
      type: "Reject(Follow)",
      actorUrl,
      actorName,
      summary: `${actorName} rejected our Follow`,
    });
  }
}

/**
 * Handle Like activity.
 *
 * Only logs likes of our own content and creates a notification.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleLike(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);

  let like;
  try {
    like = await Like.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Like from rawJson:", error.message);
    return;
  }

  const objectId = like.objectId?.href || "";

  // Only log likes of our own content
  const pubUrl = collections._publicationUrl;
  if (!objectId || (pubUrl && !objectId.startsWith(pubUrl))) return;

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

  await logActivity(collections, {
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
}

/**
 * Handle Announce (boost) activity.
 *
 * PATH 1: If boost of OUR content → notification.
 * PATH 2: If from followed account → store timeline item, quote enrichment.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleAnnounce(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);

  let announce;
  try {
    announce = await Announce.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Announce from rawJson:", error.message);
    return;
  }

  const objectId = announce.objectId?.href || "";
  if (!objectId) return;

  const actorUrl = announce.actorId?.href || "";
  const pubUrl = collections._publicationUrl;

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
    await logActivity(collections, {
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
      timelineItem.visibility = computeVisibility(object);
      await addTimelineItem(collections, timelineItem);

      // Fire-and-forget quote enrichment for boosted posts
      if (timelineItem.quoteUrl) {
        fetchAndStoreQuote(collections, timelineItem.uid, timelineItem.quoteUrl, ctx, authLoader)
          .catch((error) => {
            console.error(`[inbox-handlers] Quote fetch failed for ${timelineItem.uid}:`, error.message);
          });
      }
    } catch (error) {
      // Remote object unreachable (timeout, Authorized Fetch, deleted, etc.) — skip
      const cause = error?.cause?.code || error?.message || "unknown";
      console.warn(`[inbox-handlers] Skipped boost from ${actorUrl}: ${cause}`);
    }
  }
}

/**
 * Handle Create activity.
 *
 * Processes DMs, replies, mentions, and timeline storage.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleCreate(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);

  let create;
  try {
    create = await Create.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Create from rawJson:", error.message);
    return;
  }

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

  // --- DM detection ---
  // Check if this is a direct message before processing as reply/mention/timeline.
  // DMs are handled separately and stored in ap_messages instead of ap_timeline.
  const ourActorUrl = ctx.getActorUri(handle).href;
  const followersUrl = ctx.getFollowersUri(handle)?.href || "";

  if (isDirectMessage(object, ourActorUrl, followersUrl)) {
    const actorInfo = await extractActorInfo(actorObj, { documentLoader: authLoader });
    const rawHtml = object.content?.toString() || "";
    const contentHtml = sanitizeContent(rawHtml);
    const contentText = rawHtml.replace(/<[^>]*>/g, "").substring(0, 500);
    const published = object.published ? String(object.published) : new Date().toISOString();
    const inReplyToDM = object.replyTargetId?.href || null;

    // Store as message
    await addMessage(collections, {
      uid: object.id?.href || `dm:${actorUrl}:${Date.now()}`,
      actorUrl: actorInfo.url,
      actorName: actorInfo.name,
      actorPhoto: actorInfo.photo,
      actorHandle: actorInfo.handle,
      content: {
        text: contentText,
        html: contentHtml,
      },
      inReplyTo: inReplyToDM,
      conversationId: actorInfo.url,
      direction: "inbound",
      published,
      createdAt: new Date().toISOString(),
    });

    // Also create a notification so DMs appear in the notification tab
    await addNotification(collections, {
      uid: `dm:${object.id?.href || `${actorUrl}:${Date.now()}`}`,
      url: object.url?.href || object.id?.href || "",
      type: "dm",
      actorUrl: actorInfo.url,
      actorName: actorInfo.name,
      actorPhoto: actorInfo.photo,
      actorHandle: actorInfo.handle,
      content: {
        text: contentText,
        html: contentHtml,
      },
      published,
      createdAt: new Date().toISOString(),
    });

    await logActivity(collections, {
      direction: "inbound",
      type: "DirectMessage",
      actorUrl,
      actorName,
      actorAvatar: actorInfo.photo || "",
      objectUrl: object.id?.href || "",
      content: contentText.substring(0, 100),
      summary: `${actorName} sent a direct message`,
    });

    return; // Don't process DMs as timeline/mention/reply
  }

  // Use replyTargetId (non-fetching) for the inReplyTo URL
  const inReplyTo = object.replyTargetId?.href || null;

  // Log replies to our posts (existing behavior for conversations)
  const pubUrl = collections._publicationUrl;
  if (inReplyTo) {
    const content = object.content?.toString() || "";

    // Extract actor info (including avatar) before logging so we can store it
    const actorInfo = await extractActorInfo(actorObj, { documentLoader: authLoader });

    await logActivity(collections, {
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
        url: object.url?.href || object.id?.href || "",
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

  // --- Recursive reply chain fetching ---
  // Fetch and store ancestor posts so conversation threads have context.
  // Each ancestor is stored with isContext: true to distinguish from organic timeline items.
  if (inReplyTo) {
    try {
      const settings = await getSettings(collections);
      await fetchReplyChain(object, collections, authLoader, settings.replyChainDepth);
    } catch (error) {
      // Non-critical — incomplete context is acceptable
      console.warn("[inbox-handlers] Reply chain fetch failed:", error.message);
    }
  }

  // Check for mentions of our actor
  if (object.tag) {
    const tags = Array.isArray(object.tag) ? object.tag : [object.tag];

    for (const tag of tags) {
      if (tag.type === "Mention" && tag.href?.href === ourActorUrl) {
        const actorInfo = await extractActorInfo(actorObj, { documentLoader: authLoader });
        const rawMentionHtml = object.content?.toString() || "";
        const mentionHtml = sanitizeContent(rawMentionHtml);
        const contentText = rawMentionHtml.replace(/<[^>]*>/g, "").substring(0, 200);

        await addNotification(collections, {
          uid: object.id?.href || `mention:${actorUrl}:${object.id?.href}`,
          url: object.url?.href || object.id?.href || "",
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
      timelineItem.visibility = computeVisibility(object);
      await addTimelineItem(collections, timelineItem);

      // Fire-and-forget OG unfurling for notes and articles (not boosts)
      if (timelineItem.type === "note" || timelineItem.type === "article") {
        fetchAndStorePreviews(collections, timelineItem.uid, timelineItem.content.html)
          .catch((error) => {
            console.error(`[inbox-handlers] OG unfurl failed for ${timelineItem.uid}:`, error);
          });
      }

      // Fire-and-forget quote enrichment
      if (timelineItem.quoteUrl) {
        fetchAndStoreQuote(collections, timelineItem.uid, timelineItem.quoteUrl, ctx, authLoader)
          .catch((error) => {
            console.error(`[inbox-handlers] Quote fetch failed for ${timelineItem.uid}:`, error.message);
          });
      }
    } catch (error) {
      // Log extraction errors but don't fail the entire handler
      console.error("[inbox-handlers] Failed to store timeline item:", error);
    }
  } else if (collections.ap_followed_tags) {
    // Not a followed account — check if the post's hashtags match any followed tags
    // so tagged posts from across the fediverse appear in the timeline
    try {
      const objectTags = Array.isArray(object.tag) ? object.tag : (object.tag ? [object.tag] : []);
      const postHashtags = objectTags
        .filter((t) => t.type === "Hashtag" && t.name)
        .map((t) => t.name.toString().replace(/^#/, "").toLowerCase());

      if (postHashtags.length > 0) {
        const followedTags = await getFollowedTags(collections);
        const followedSet = new Set(followedTags.map((t) => t.toLowerCase()));
        const hasMatchingTag = postHashtags.some((tag) => followedSet.has(tag));

        if (hasMatchingTag) {
          const timelineItem = await extractObjectData(object, {
            actorFallback: actorObj,
            documentLoader: authLoader,
          });
          timelineItem.visibility = computeVisibility(object);
          await addTimelineItem(collections, timelineItem);
        }
      }
    } catch (error) {
      // Non-critical — don't fail the handler
      console.error("[inbox-handlers] Followed tag check failed:", error.message);
    }
  }
}

/**
 * Handle Delete activity.
 *
 * Removes from ap_activities and timeline by object URL.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 */
export async function handleDelete(item, collections) {
  const objectId = item.objectUrl;
  if (objectId) {
    // Remove from activity log
    await collections.ap_activities.deleteMany({ objectUrl: objectId });

    // Remove from timeline
    await deleteTimelineItem(collections, objectId);
  }
}

/**
 * Handle Move activity.
 *
 * Updates ap_followers to reflect the actor's new URL.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleMove(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);

  let move;
  try {
    move = await Move.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Move from rawJson:", error.message);
    return;
  }

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

  await logActivity(collections, {
    direction: "inbound",
    type: "Move",
    actorUrl: oldActorUrl,
    objectUrl: newActorUrl,
    summary: `${oldActorUrl} moved to ${newActorUrl}`,
  });
}

/**
 * Handle Update activity.
 *
 * PATH 1: If Note/Article → update timeline item content.
 * PATH 2: Otherwise → refresh stored follower data.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleUpdate(item, collections, ctx, handle) {
  const authLoader = await getAuthLoader(ctx, handle);

  let update;
  try {
    update = await Update.fromJsonLd(item.rawJson, { documentLoader: authLoader });
  } catch (error) {
    console.warn("[inbox-handlers] Failed to reconstruct Update from rawJson:", error.message);
    return;
  }

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
        console.error("[inbox-handlers] Failed to update timeline item:", error);
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
}

/**
 * Handle Block activity.
 *
 * The synchronous inbox listener already handled follower removal.
 * This async handler only logs the activity.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 */
export async function handleBlock(item, collections) {
  await logActivity(collections, {
    direction: "inbound",
    type: "Block",
    actorUrl: item.actorUrl,
    summary: `${item.actorUrl} block activity processed`,
  });
}

/**
 * Handle Flag (report) activity.
 *
 * Stores the report in ap_reports, creates a notification, and logs the activity.
 *
 * @param {object} item - Queue document
 * @param {object} collections - MongoDB collections
 * @param {import("@fedify/fedify").Context} ctx - Fedify context
 * @param {string} handle - Actor handle
 */
export async function handleFlag(item, collections, ctx, handle) {
  try {
    const authLoader = await getAuthLoader(ctx, handle);

    let flag;
    try {
      flag = await Flag.fromJsonLd(item.rawJson, { documentLoader: authLoader });
    } catch (error) {
      console.warn("[inbox-handlers] Failed to reconstruct Flag from rawJson:", error.message);
      return;
    }

    const actorObj = await flag.getActor({ documentLoader: authLoader }).catch(() => null);

    const reporterUrl = actorObj?.id?.href || flag.actorId?.href || "";
    const reporterName = actorObj?.name?.toString() || actorObj?.preferredUsername?.toString() || reporterUrl;

    // Extract reported objects — Flag can report actors or posts
    const reportedIds = flag.objectIds?.map((u) => u.href) || [];
    const reason = flag.content?.toString() || flag.summary?.toString() || "";

    if (reportedIds.length === 0 && !reason) {
      console.info("[inbox-handlers] Ignoring empty Flag from", reporterUrl);
      return;
    }

    // Store report
    if (collections.ap_reports) {
      await collections.ap_reports.insertOne({
        reporterUrl,
        reporterName,
        reportedUrls: reportedIds,
        reason,
        createdAt: new Date().toISOString(),
        read: false,
      });
    }

    // Create notification
    if (collections.ap_notifications) {
      await addNotification(collections, {
        uid: `flag:${reporterUrl}:${Date.now()}`,
        type: "report",
        actorUrl: reporterUrl,
        actorName: reporterName,
        actorPhoto: actorObj?.iconUrl?.href || actorObj?.icon?.url?.href || "",
        actorHandle: actorObj?.preferredUsername
          ? `@${actorObj.preferredUsername}@${new URL(reporterUrl).hostname}`
          : reporterUrl,
        objectUrl: reportedIds[0] || "",
        summary: reason ? reason.slice(0, 200) : "Report received",
        published: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    }

    await logActivity(collections, {
      direction: "inbound",
      type: "Flag",
      actorUrl: reporterUrl,
      objectUrl: reportedIds[0] || "",
      summary: `Report from ${reporterName}: ${reason.slice(0, 100)}`,
    });

    console.info(`[inbox-handlers] Flag received from ${reporterName} — ${reportedIds.length} objects reported`);
  } catch (error) {
    console.warn("[inbox-handlers] Flag handler error:", error.message);
  }
}
