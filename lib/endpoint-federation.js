/**
 * Federation send-path actions, extracted from the index.js god-entry
 * (Phase 2). Each takes `self` (the ActivityPubEndpoint instance); the class
 * keeps thin delegating methods so the public interface + the init() facade
 * are preserved. Internal cross-calls go directly to the module functions.
 */
import {
  needsDirectFollow,
  sendDirectFollow,
  sendDirectUnfollow,
} from "./direct-follow.js";
import { lookupWithSecurity } from "./lookup-helpers.js";
import { logActivity } from "./activity-log.js";
import { batchBroadcast } from "./batch-broadcast.js";
import { buildPersonActor } from "./federation-setup.js";
import { jf2ToAS2Activity } from "./jf2-to-as2.js";

/**
 * Load the RSA private key from ap_keys for direct HTTP Signature signing.
 * @returns {Promise<CryptoKey|null>}
 */
export async function loadRsaPrivateKey(self) {
  try {
    const keyDoc = await self._collections.ap_keys.findOne({
      privateKeyPem: { $exists: true },
    });
    if (!keyDoc?.privateKeyPem) return null;
    const pemBody = keyDoc.privateKeyPem
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s/g, "");
    return await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(pemBody, "base64"),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["sign"],
    );
  } catch (error) {
    console.error("[ActivityPub] Failed to load RSA key:", error.message);
    return null;
  }
}

/** Send a Follow activity to a remote actor and store in ap_following. */
export async function followActor(self, actorUrl, actorInfo = {}) {
  if (!self._federation) {
    return { ok: false, error: "Federation not initialized" };
  }

  try {
    const { Follow } = await import("@fedify/fedify/vocab");
    const handle = self.options.actor.handle;
    const ctx = self._federation.createContext(
      new URL(self._publicationUrl),
      { handle, publicationUrl: self._publicationUrl },
    );

    // Resolve the remote actor to get their inbox
    // lookupWithSecurity handles signed→unsigned fallback automatically
    const documentLoader = await ctx.getDocumentLoader({
      identifier: handle,
    });
    const remoteActor = await lookupWithSecurity(ctx, actorUrl, {
      documentLoader,
    });
    if (!remoteActor) {
      return { ok: false, error: "Could not resolve remote actor" };
    }

    // Send Follow activity
    if (needsDirectFollow(actorUrl)) {
      // tags.pub rejects Fedify's LD Signature context (identity/v1).
      // Send a minimal signed Follow directly, bypassing the outbox pipeline.
      // See: https://github.com/social-web-foundation/tags.pub/issues/10
      const rsaKey = await loadRsaPrivateKey(self);
      if (!rsaKey) {
        return { ok: false, error: "No RSA key available for direct follow" };
      }
      const result = await sendDirectFollow({
        actorUri: ctx.getActorUri(handle).href,
        targetActorUrl: actorUrl,
        inboxUrl: remoteActor.inboxId?.href,
        keyId: `${ctx.getActorUri(handle).href}#main-key`,
        privateKey: rsaKey,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
    } else {
      const follow = new Follow({
        actor: ctx.getActorUri(handle),
        object: new URL(actorUrl),
      });
      await ctx.sendActivity({ identifier: handle }, remoteActor, follow, {
        orderingKey: actorUrl,
      });
    }

    // Store in ap_following
    const name =
      actorInfo.name ||
      remoteActor.name?.toString() ||
      remoteActor.preferredUsername?.toString() ||
      actorUrl;
    const actorHandle =
      actorInfo.handle ||
      remoteActor.preferredUsername?.toString() ||
      "";
    const avatar =
      actorInfo.photo ||
      (remoteActor.icon
        ? (await remoteActor.icon)?.url?.href || ""
        : "");
    const inbox = remoteActor.inboxId?.href || "";
    const sharedInbox = remoteActor.endpoints?.sharedInbox?.href || "";

    await self._collections.ap_following.updateOne(
      { actorUrl },
      {
        $set: {
          actorUrl,
          handle: actorHandle,
          name,
          avatar,
          inbox,
          sharedInbox,
          followedAt: new Date().toISOString(),
          source: "reader",
        },
      },
      { upsert: true },
    );

    console.info(`[ActivityPub] Sent Follow to ${actorUrl}`);

    await logActivity(self._collections.ap_activities, {
      direction: "outbound",
      type: "Follow",
      actorUrl: self._publicationUrl,
      objectUrl: actorUrl,
      actorName: name,
      summary: `Sent Follow to ${name} (${actorUrl})`,
    });

    return { ok: true };
  } catch (error) {
    console.error(`[ActivityPub] Follow failed for ${actorUrl}:`, error.message);

    await logActivity(self._collections.ap_activities, {
      direction: "outbound",
      type: "Follow",
      actorUrl: self._publicationUrl,
      objectUrl: actorUrl,
      summary: `Follow failed for ${actorUrl}: ${error.message}`,
    }).catch(() => {});

    return { ok: false, error: error.message };
  }
}

/** Send an Undo(Follow) activity and remove from ap_following. */
export async function unfollowActor(self, actorUrl) {
  if (!self._federation) {
    return { ok: false, error: "Federation not initialized" };
  }

  try {
    const { Follow, Undo } = await import("@fedify/fedify/vocab");
    const handle = self.options.actor.handle;
    const ctx = self._federation.createContext(
      new URL(self._publicationUrl),
      { handle, publicationUrl: self._publicationUrl },
    );

    // Use authenticated document loader for servers requiring Authorized Fetch
    const documentLoader = await ctx.getDocumentLoader({
      identifier: handle,
    });
    const remoteActor = await lookupWithSecurity(ctx, actorUrl, {
      documentLoader,
    });
    if (!remoteActor) {
      // Even if we can't resolve, remove locally
      await self._collections.ap_following.deleteOne({ actorUrl });

      await logActivity(self._collections.ap_activities, {
        direction: "outbound",
        type: "Undo(Follow)",
        actorUrl: self._publicationUrl,
        objectUrl: actorUrl,
        summary: `Removed ${actorUrl} locally (could not resolve remote actor)`,
      }).catch(() => {});

      return { ok: true };
    }

    if (needsDirectFollow(actorUrl)) {
      // tags.pub rejects Fedify's LD Signature context (identity/v1).
      // See: https://github.com/social-web-foundation/tags.pub/issues/10
      const rsaKey = await loadRsaPrivateKey(self);
      if (rsaKey) {
        const result = await sendDirectUnfollow({
          actorUri: ctx.getActorUri(handle).href,
          targetActorUrl: actorUrl,
          inboxUrl: remoteActor.inboxId?.href,
          keyId: `${ctx.getActorUri(handle).href}#main-key`,
          privateKey: rsaKey,
        });
        if (!result.ok) {
          console.warn(`[ActivityPub] Direct unfollow failed for ${actorUrl}: ${result.error}`);
        }
      }
    } else {
      const follow = new Follow({
        actor: ctx.getActorUri(handle),
        object: new URL(actorUrl),
      });
      const undo = new Undo({
        actor: ctx.getActorUri(handle),
        object: follow,
      });
      await ctx.sendActivity({ identifier: handle }, remoteActor, undo, {
        orderingKey: actorUrl,
      });
    }
    await self._collections.ap_following.deleteOne({ actorUrl });

    console.info(`[ActivityPub] Sent Undo(Follow) to ${actorUrl}`);

    await logActivity(self._collections.ap_activities, {
      direction: "outbound",
      type: "Undo(Follow)",
      actorUrl: self._publicationUrl,
      objectUrl: actorUrl,
      summary: `Sent Undo(Follow) to ${actorUrl}`,
    });

    return { ok: true };
  } catch (error) {
    console.error(`[ActivityPub] Unfollow failed for ${actorUrl}:`, error.message);

    await logActivity(self._collections.ap_activities, {
      direction: "outbound",
      type: "Undo(Follow)",
      actorUrl: self._publicationUrl,
      objectUrl: actorUrl,
      summary: `Unfollow failed for ${actorUrl}: ${error.message}`,
    }).catch(() => {});

    // Remove locally even if remote delivery fails
    await self._collections.ap_following.deleteOne({ actorUrl }).catch(() => {});
    return { ok: false, error: error.message };
  }
}

/** Send an Update(Person) to all followers so they re-fetch the actor. */
export async function broadcastActorUpdate(self) {
  if (!self._federation) return;

  try {
    const { Update } = await import("@fedify/fedify/vocab");
    const handle = self.options.actor.handle;
    const ctx = self._federation.createContext(
      new URL(self._publicationUrl),
      { handle, publicationUrl: self._publicationUrl },
    );

    const actor = await buildPersonActor(
      ctx,
      handle,
      self._collections,
      self.options.actorType,
    );
    if (!actor) {
      console.warn("[ActivityPub] broadcastActorUpdate: could not build actor");
      return;
    }

    const update = new Update({
      actor: ctx.getActorUri(handle),
      object: actor,
    });

    await batchBroadcast({
      federation: self._federation,
      collections: self._collections,
      publicationUrl: self._publicationUrl,
      handle,
      activity: update,
      label: "Update(Person)",
      objectUrl: getActorUrl(self),
    });
  } catch (error) {
    console.error("[ActivityPub] broadcastActorUpdate failed:", error.message);
  }
}

/** Send a Delete activity to all followers for a removed post. */
export async function broadcastDelete(self, postUrl) {
  if (!self._federation) return;

  try {
    const { Delete } = await import("@fedify/fedify/vocab");
    const handle = self.options.actor.handle;
    const ctx = self._federation.createContext(
      new URL(self._publicationUrl),
      { handle, publicationUrl: self._publicationUrl },
    );

    const del = new Delete({
      actor: ctx.getActorUri(handle),
      object: new URL(postUrl),
    });

    await batchBroadcast({
      federation: self._federation,
      collections: self._collections,
      publicationUrl: self._publicationUrl,
      handle,
      activity: del,
      label: "Delete",
      objectUrl: postUrl,
    });
  } catch (error) {
    console.warn("[ActivityPub] broadcastDelete failed:", error.message);
  }
}

/** Micropub delete hook: record a tombstone (FEP-4f05) + broadcast Delete. */
export async function deletePost(self, url) {
  // Record tombstone for FEP-4f05
  try {
    const { addTombstone } = await import("./storage/tombstones.js");
    const postsCol = self._collections.posts;
    const post = postsCol ? await postsCol.findOne({ "properties.url": url }) : null;
    await addTombstone(self._collections, {
      url,
      formerType: post?.properties?.["post-type"] === "article" ? "Article" : "Note",
      published: post?.properties?.published || null,
      deleted: new Date().toISOString(),
    });
  } catch (error) {
    console.warn(`[ActivityPub] Tombstone creation failed for ${url}: ${error.message}`);
  }

  await broadcastDelete(self, url).catch((err) =>
    console.warn(`[ActivityPub] broadcastDelete failed for ${url}: ${err.message}`)
  );
}

/** Micropub update hook: broadcast an Update for the modified post. */
export async function updatePost(self, properties) {
  await broadcastPostUpdate(self, properties).catch((err) =>
    console.warn(`[ActivityPub] broadcastPostUpdate failed for ${properties?.url}: ${err.message}`)
  );
}

/** Send an Update activity to all followers for a modified post. */
export async function broadcastPostUpdate(self, properties) {
  if (!self._federation) return;

  try {
    const { Update } = await import("@fedify/fedify/vocab");
    const actorUrl = getActorUrl(self);
    const handle = self.options.actor.handle;
    const ctx = self._federation.createContext(
      new URL(self._publicationUrl),
      { handle, publicationUrl: self._publicationUrl },
    );

    const createActivity = jf2ToAS2Activity(
      properties,
      actorUrl,
      self._publicationUrl,
      { visibility: self.options.defaultVisibility },
    );

    if (!createActivity) {
      console.warn(`[ActivityPub] broadcastPostUpdate: could not convert post to AS2 for ${properties?.url}`);
      return;
    }

    const noteObject = await createActivity.getObject();
    const activity = new Update({
      actor: ctx.getActorUri(handle),
      object: noteObject,
    });

    await batchBroadcast({
      federation: self._federation,
      collections: self._collections,
      publicationUrl: self._publicationUrl,
      handle,
      activity,
      label: "Update(Note)",
      objectUrl: properties.url,
    });
  } catch (error) {
    console.warn("[ActivityPub] broadcastPostUpdate failed:", error.message);
  }
}

/** Build the full actor URL from config. */
export function getActorUrl(self) {
  const base = self._publicationUrl.replace(/\/$/, "");
  return `${base}${self.options.mountPath}/users/${self.options.actor.handle}`;
}
