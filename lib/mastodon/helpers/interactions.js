/**
 * Shared interaction logic for like/unlike, boost/unboost, bookmark/unbookmark.
 *
 * Extracted from admin controllers (interactions-like.js, interactions-boost.js)
 * so that both the admin UI and Mastodon Client API can reuse the same core logic.
 *
 * Each function accepts a context object instead of Express req/res,
 * making them transport-agnostic.
 */

import { resolveAuthor } from "../../resolve-author.js";

/**
 * Like a post — send Like activity and track in ap_interactions.
 *
 * @param {object} params
 * @param {string} params.targetUrl - URL of the post to like
 * @param {object} params.federation - Fedify federation instance
 * @param {string} params.handle - Local actor handle
 * @param {string} params.publicationUrl - Publication base URL
 * @param {object} params.collections - MongoDB collections (Map or object)
 * @param {object} params.interactions - ap_interactions collection
 * @returns {Promise<{ activityId: string }>}
 */
export async function likePost({ targetUrl, federation, handle, publicationUrl, collections, interactions }) {
  const { Like } = await import("@fedify/fedify/vocab");
  const ctx = federation.createContext(
    new URL(publicationUrl),
    { handle, publicationUrl },
  );

  const documentLoader = await ctx.getDocumentLoader({ identifier: handle });
  const recipient = await resolveAuthor(targetUrl, ctx, documentLoader, collections);

  const uuid = crypto.randomUUID();
  const baseUrl = publicationUrl.replace(/\/$/, "");
  const activityId = `${baseUrl}/activitypub/likes/${uuid}`;

  const like = new Like({
    id: new URL(activityId),
    actor: ctx.getActorUri(handle),
    object: new URL(targetUrl),
  });

  if (recipient) {
    await ctx.sendActivity({ identifier: handle }, recipient, like, {
      orderingKey: targetUrl,
    });
  }

  if (interactions) {
    await interactions.updateOne(
      { objectUrl: targetUrl, type: "like" },
      {
        $set: {
          objectUrl: targetUrl,
          type: "like",
          activityId,
          recipientUrl: recipient?.id?.href || "",
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  }

  return { activityId };
}

/**
 * Unlike a post — send Undo(Like) activity and remove from ap_interactions.
 *
 * @param {object} params
 * @param {string} params.targetUrl - URL of the post to unlike
 * @param {object} params.federation - Fedify federation instance
 * @param {string} params.handle - Local actor handle
 * @param {string} params.publicationUrl - Publication base URL
 * @param {object} params.collections - MongoDB collections
 * @param {object} params.interactions - ap_interactions collection
 * @returns {Promise<void>}
 */
export async function unlikePost({ targetUrl, federation, handle, publicationUrl, collections, interactions }) {
  const existing = interactions
    ? await interactions.findOne({ objectUrl: targetUrl, type: "like" })
    : null;

  if (!existing) {
    return;
  }

  const { Like, Undo } = await import("@fedify/fedify/vocab");
  const ctx = federation.createContext(
    new URL(publicationUrl),
    { handle, publicationUrl },
  );

  const documentLoader = await ctx.getDocumentLoader({ identifier: handle });
  const recipient = await resolveAuthor(targetUrl, ctx, documentLoader, collections);

  if (recipient) {
    const like = new Like({
      id: existing.activityId ? new URL(existing.activityId) : undefined,
      actor: ctx.getActorUri(handle),
      object: new URL(targetUrl),
    });

    const undo = new Undo({
      actor: ctx.getActorUri(handle),
      object: like,
    });

    await ctx.sendActivity({ identifier: handle }, recipient, undo, {
      orderingKey: targetUrl,
    });
  }

  if (interactions) {
    await interactions.deleteOne({ objectUrl: targetUrl, type: "like" });
  }
}

/**
 * Boost a post — send Announce activity and track in ap_interactions.
 *
 * @param {object} params
 * @param {string} params.targetUrl - URL of the post to boost
 * @param {object} params.federation - Fedify federation instance
 * @param {string} params.handle - Local actor handle
 * @param {string} params.publicationUrl - Publication base URL
 * @param {object} params.collections - MongoDB collections
 * @param {object} params.interactions - ap_interactions collection
 * @returns {Promise<{ activityId: string }>}
 */
export async function boostPost({ targetUrl, federation, handle, publicationUrl, collections, interactions }) {
  const { Announce } = await import("@fedify/fedify/vocab");
  const ctx = federation.createContext(
    new URL(publicationUrl),
    { handle, publicationUrl },
  );

  const uuid = crypto.randomUUID();
  const baseUrl = publicationUrl.replace(/\/$/, "");
  const activityId = `${baseUrl}/activitypub/boosts/${uuid}`;

  const publicAddress = new URL("https://www.w3.org/ns/activitystreams#Public");
  const followersUri = ctx.getFollowersUri(handle);

  const announce = new Announce({
    id: new URL(activityId),
    actor: ctx.getActorUri(handle),
    object: new URL(targetUrl),
    to: publicAddress,
    cc: followersUri,
  });

  // Send to followers
  await ctx.sendActivity({ identifier: handle }, "followers", announce, {
    preferSharedInbox: true,
    syncCollection: true,
    orderingKey: targetUrl,
  });

  // Also send directly to the original post author
  const documentLoader = await ctx.getDocumentLoader({ identifier: handle });
  const recipient = await resolveAuthor(targetUrl, ctx, documentLoader, collections);
  if (recipient) {
    try {
      await ctx.sendActivity({ identifier: handle }, recipient, announce, {
        orderingKey: targetUrl,
      });
    } catch {
      // Non-critical — follower delivery already happened
    }
  }

  if (interactions) {
    await interactions.updateOne(
      { objectUrl: targetUrl, type: "boost" },
      {
        $set: {
          objectUrl: targetUrl,
          type: "boost",
          activityId,
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  }

  return { activityId };
}

/**
 * Unboost a post — send Undo(Announce) activity and remove from ap_interactions.
 *
 * @param {object} params
 * @param {string} params.targetUrl - URL of the post to unboost
 * @param {object} params.federation - Fedify federation instance
 * @param {string} params.handle - Local actor handle
 * @param {string} params.publicationUrl - Publication base URL
 * @param {object} params.interactions - ap_interactions collection
 * @returns {Promise<void>}
 */
export async function unboostPost({ targetUrl, federation, handle, publicationUrl, interactions }) {
  const existing = interactions
    ? await interactions.findOne({ objectUrl: targetUrl, type: "boost" })
    : null;

  if (!existing) {
    return;
  }

  const { Announce, Undo } = await import("@fedify/fedify/vocab");
  const ctx = federation.createContext(
    new URL(publicationUrl),
    { handle, publicationUrl },
  );

  const announce = new Announce({
    id: existing.activityId ? new URL(existing.activityId) : undefined,
    actor: ctx.getActorUri(handle),
    object: new URL(targetUrl),
  });

  const undo = new Undo({
    actor: ctx.getActorUri(handle),
    object: announce,
  });

  await ctx.sendActivity({ identifier: handle }, "followers", undo, {
    preferSharedInbox: true,
    syncCollection: true,
    orderingKey: targetUrl,
  });

  if (interactions) {
    await interactions.deleteOne({ objectUrl: targetUrl, type: "boost" });
  }
}

/**
 * Bookmark a post — local-only, no federation.
 *
 * @param {object} params
 * @param {string} params.targetUrl - URL of the post to bookmark
 * @param {object} params.interactions - ap_interactions collection
 * @returns {Promise<void>}
 */
export async function bookmarkPost({ targetUrl, interactions }) {
  if (!interactions) return;

  await interactions.updateOne(
    { objectUrl: targetUrl, type: "bookmark" },
    {
      $set: {
        objectUrl: targetUrl,
        type: "bookmark",
        createdAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

/**
 * Remove a bookmark — local-only, no federation.
 *
 * @param {object} params
 * @param {string} params.targetUrl - URL of the post to unbookmark
 * @param {object} params.interactions - ap_interactions collection
 * @returns {Promise<void>}
 */
export async function unbookmarkPost({ targetUrl, interactions }) {
  if (!interactions) return;

  await interactions.deleteOne({ objectUrl: targetUrl, type: "bookmark" });
}
