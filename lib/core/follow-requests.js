/**
 * Follow-request domain logic — the single implementation both surfaces call.
 *
 * AP-D8: the reader had approve/reject wired; the Mastodon Client API had
 * neither. Once GET /api/v1/follow_requests started returning real data
 * (v3.13.21/27) that became a DEAD CONTROL — a request visible on the phone
 * that could only be actioned from a desktop. Arguably worse than invisible,
 * because the client advertises a button that does nothing.
 *
 * The federation half (Accept / Reject delivery) is best-effort by design:
 * local state is authoritative and must not be left inconsistent because a
 * remote inbox was unreachable.
 *
 * @module core/follow-requests
 */
import { logActivity } from "../activity-log.js";
import { lookupWithSecurity } from "../lookup-helpers.js";

/**
 * Pending follow requests.
 *
 * @param {object} collections
 * @returns {Promise<object[]>}
 */
export async function getPendingFollows(collections) {
  if (!collections.ap_pending_follows) return [];
  return collections.ap_pending_follows.find({}).toArray();
}

/**
 * Find a pending request by an adapter-minted surface id.
 *
 * DD-5: core keys on the actor URI. Adapters mint their own ids, so they pass
 * a matcher rather than an id core would have to understand.
 *
 * @param {object} collections
 * @param {(actorUrl: string) => boolean} matches
 * @returns {Promise<object|null>}
 */
export async function findPendingBy(collections, matches) {
  const pending = await getPendingFollows(collections);
  return pending.find((p) => matches(p.actorUrl)) || null;
}

/**
 * Approve a follow request: promote to follower, drop from pending, Accept.
 *
 * @param {object} collections
 * @param {string} actorUrl
 * @param {object} [federation] - { federation, handle, publicationUrl }
 * @returns {Promise<{ok: boolean, error?: string, delivered?: boolean}>}
 */
export async function approveFollow(collections, actorUrl, federation = {}) {
  const { ap_pending_follows, ap_followers } = collections;

  if (!ap_pending_follows || !ap_followers) {
    return { ok: false, error: "Collections not available" };
  }

  const pending = await ap_pending_follows.findOne({ actorUrl });
  if (!pending) {
    return { ok: false, error: "No pending follow request from this actor" };
  }

  await ap_followers.updateOne(
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

  await ap_pending_follows.deleteOne({ actorUrl });

  const delivered = await deliverFollowResponse(
    collections,
    actorUrl,
    pending,
    federation,
    "Accept",
  );

  return { ok: true, delivered };
}

/**
 * Reject a follow request: drop from pending, Reject.
 *
 * @param {object} collections
 * @param {string} actorUrl
 * @param {object} [federation]
 * @returns {Promise<{ok: boolean, error?: string, delivered?: boolean}>}
 */
export async function rejectFollow(collections, actorUrl, federation = {}) {
  const { ap_pending_follows } = collections;

  if (!ap_pending_follows) {
    return { ok: false, error: "Collections not available" };
  }

  const pending = await ap_pending_follows.findOne({ actorUrl });
  if (!pending) {
    return { ok: false, error: "No pending follow request from this actor" };
  }

  await ap_pending_follows.deleteOne({ actorUrl });

  const delivered = await deliverFollowResponse(
    collections,
    actorUrl,
    pending,
    federation,
    "Reject",
  );

  return { ok: true, delivered };
}

/**
 * Send Accept(Follow) or Reject(Follow) to the requesting actor.
 *
 * Best-effort: returns false rather than throwing. Local state is already
 * committed by the time this runs, and a remote outage must not roll it back.
 *
 * @returns {Promise<boolean>} whether delivery was attempted successfully
 */
async function deliverFollowResponse(
  collections,
  actorUrl,
  pending,
  { federation, handle, publicationUrl } = {},
  kind,
) {
  if (!federation || !handle || !publicationUrl) return false;

  try {
    const vocab = await import("@fedify/vocab");
    const Response_ = kind === "Accept" ? vocab.Accept : vocab.Reject;
    const { Follow } = vocab;

    const ctx = federation.createContext(new URL(publicationUrl), {
      handle,
      publicationUrl,
    });

    const documentLoader = await ctx.getDocumentLoader({ identifier: handle });

    const remoteActor = await lookupWithSecurity(ctx, new URL(actorUrl), {
      documentLoader,
    });

    if (!remoteActor) return false;

    // Reconstruct the original Follow so the remote can correlate the response.
    const followObj = new Follow({
      id: pending.followActivityId ? new URL(pending.followActivityId) : undefined,
      actor: new URL(actorUrl),
      object: ctx.getActorUri(handle),
    });

    await ctx.sendActivity(
      { identifier: handle },
      remoteActor,
      new Response_({
        actor: ctx.getActorUri(handle),
        object: followObj,
      }),
      { orderingKey: actorUrl },
    );

    if (collections.ap_activities) {
      await logActivity(collections.ap_activities, {
        direction: "outbound",
        type: `${kind}(Follow)`,
        actorUrl: publicationUrl,
        objectUrl: actorUrl,
        actorName: pending.name || actorUrl,
        summary: `${kind === "Accept" ? "Approved" : "Rejected"} follow request from ${
          pending.name || actorUrl
        }`,
      });
    }

    return true;
  } catch (error) {
    console.warn(
      `[ActivityPub] Could not send ${kind} to ${actorUrl}: ${error.message}`,
    );
    return false;
  }
}
