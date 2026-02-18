/**
 * Inbox activity processors.
 *
 * Each handler receives a parsed ActivityStreams activity, the MongoDB
 * collections, and a context object with delivery capabilities.
 * Activities are auto-accepted (Follow) and logged for the admin UI.
 */

/**
 * Dispatch an incoming activity to the appropriate handler.
 *
 * @param {object} activity - Parsed ActivityStreams activity
 * @param {object} collections - MongoDB collections (ap_followers, ap_following, ap_activities)
 * @param {object} context - { actorUrl, deliverActivity(activity, inboxUrl), storeRawActivities }
 */
export async function processInboxActivity(activity, collections, context) {
  const type = activity.type;

  switch (type) {
    case "Follow":
      return handleFollow(activity, collections, context);
    case "Undo":
      return handleUndo(activity, collections, context);
    case "Like":
      return handleLike(activity, collections, context);
    case "Announce":
      return handleAnnounce(activity, collections, context);
    case "Create":
      return handleCreate(activity, collections, context);
    case "Delete":
      return handleDelete(activity, collections);
    case "Move":
      return handleMove(activity, collections, context);
    default:
      await logActivity(collections, context, {
        direction: "inbound",
        type,
        actorUrl: resolveActorUrl(activity.actor),
        summary: `Received unhandled activity: ${type}`,
        raw: activity,
      });
  }
}

/**
 * Handle Follow — store follower, send Accept back.
 */
async function handleFollow(activity, collections, context) {
  const followerActorUrl = resolveActorUrl(activity.actor);

  // Fetch remote actor profile for display info
  const profile = await fetchActorProfile(followerActorUrl);

  // Upsert follower record
  await collections.ap_followers.updateOne(
    { actorUrl: followerActorUrl },
    {
      $set: {
        actorUrl: followerActorUrl,
        handle: profile.preferredUsername || "",
        name:
          profile.name || profile.preferredUsername || followerActorUrl,
        avatar: profile.icon?.url || "",
        inbox: profile.inbox || "",
        sharedInbox: profile.endpoints?.sharedInbox || "",
        followedAt: new Date(),
      },
    },
    { upsert: true },
  );

  // Send Accept(Follow) back to the follower's inbox
  const acceptActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Accept",
    actor: context.actorUrl,
    object: activity,
  };

  const targetInbox = profile.inbox || `${followerActorUrl}inbox`;
  await context.deliverActivity(acceptActivity, targetInbox);

  await logActivity(collections, context, {
    direction: "inbound",
    type: "Follow",
    actorUrl: followerActorUrl,
    actorName:
      profile.name || profile.preferredUsername || followerActorUrl,
    summary: `${profile.name || followerActorUrl} followed you`,
    raw: activity,
  });
}

/**
 * Handle Undo — dispatch based on the inner activity type.
 */
async function handleUndo(activity, collections, context) {
  const inner =
    typeof activity.object === "string" ? { type: "unknown" } : activity.object;
  const actorUrl = resolveActorUrl(activity.actor);

  switch (inner.type) {
    case "Follow":
      await collections.ap_followers.deleteOne({ actorUrl });
      await logActivity(collections, context, {
        direction: "inbound",
        type: "Undo(Follow)",
        actorUrl,
        summary: `${actorUrl} unfollowed you`,
        raw: activity,
      });
      break;

    case "Like":
      await collections.ap_activities.deleteOne({
        type: "Like",
        actorUrl,
        objectUrl: resolveObjectUrl(inner.object),
      });
      break;

    case "Announce":
      await collections.ap_activities.deleteOne({
        type: "Announce",
        actorUrl,
        objectUrl: resolveObjectUrl(inner.object),
      });
      break;

    default:
      await logActivity(collections, context, {
        direction: "inbound",
        type: `Undo(${inner.type})`,
        actorUrl,
        summary: `${actorUrl} undid ${inner.type}`,
        raw: activity,
      });
  }
}

/**
 * Handle Like — log for admin display.
 */
async function handleLike(activity, collections, context) {
  const actorUrl = resolveActorUrl(activity.actor);
  const objectUrl = resolveObjectUrl(activity.object);
  const profile = await fetchActorProfile(actorUrl);

  await logActivity(collections, context, {
    direction: "inbound",
    type: "Like",
    actorUrl,
    actorName: profile.name || profile.preferredUsername || actorUrl,
    objectUrl,
    summary: `${profile.name || actorUrl} liked ${objectUrl}`,
    raw: activity,
  });
}

/**
 * Handle Announce (boost) — log for admin display.
 */
async function handleAnnounce(activity, collections, context) {
  const actorUrl = resolveActorUrl(activity.actor);
  const objectUrl = resolveObjectUrl(activity.object);
  const profile = await fetchActorProfile(actorUrl);

  await logActivity(collections, context, {
    direction: "inbound",
    type: "Announce",
    actorUrl,
    actorName: profile.name || profile.preferredUsername || actorUrl,
    objectUrl,
    summary: `${profile.name || actorUrl} boosted ${objectUrl}`,
    raw: activity,
  });
}

/**
 * Handle Create — if it's a reply to one of our posts, log it.
 */
async function handleCreate(activity, collections, context) {
  const object =
    typeof activity.object === "string" ? { id: activity.object } : activity.object;
  const inReplyTo = object.inReplyTo;

  // Only log replies to our posts (inReplyTo is set)
  if (!inReplyTo) return;

  const actorUrl = resolveActorUrl(activity.actor);
  const profile = await fetchActorProfile(actorUrl);

  await logActivity(collections, context, {
    direction: "inbound",
    type: "Reply",
    actorUrl,
    actorName: profile.name || profile.preferredUsername || actorUrl,
    objectUrl: object.id || object.url || "",
    summary: `${profile.name || actorUrl} replied to ${inReplyTo}`,
    raw: activity,
  });
}

/**
 * Handle Delete — remove activity records for deleted objects.
 */
async function handleDelete(activity, collections) {
  const objectUrl = resolveObjectUrl(activity.object);
  if (objectUrl) {
    await collections.ap_activities.deleteMany({ objectUrl });
  }
}

/**
 * Handle Move — update follower record if actor moved to a new account.
 * This is part of the Mastodon migration flow: after a Move, followers
 * are expected to re-follow the new account.
 */
async function handleMove(activity, collections, context) {
  const oldActorUrl = resolveActorUrl(activity.actor);
  const newActorUrl = resolveObjectUrl(activity.target || activity.object);

  if (oldActorUrl && newActorUrl) {
    await collections.ap_followers.updateOne(
      { actorUrl: oldActorUrl },
      { $set: { actorUrl: newActorUrl, movedFrom: oldActorUrl } },
    );
  }

  await logActivity(collections, context, {
    direction: "inbound",
    type: "Move",
    actorUrl: oldActorUrl,
    objectUrl: newActorUrl,
    summary: `${oldActorUrl} moved to ${newActorUrl}`,
    raw: activity,
  });
}

// --- Helpers ---

/**
 * Extract actor URL from an activity's actor field.
 * The actor can be a string URL or an object with an id field.
 */
function resolveActorUrl(actor) {
  if (typeof actor === "string") return actor;
  return actor?.id || "";
}

/**
 * Extract object URL from an activity's object field.
 */
function resolveObjectUrl(object) {
  if (typeof object === "string") return object;
  return object?.id || object?.url || "";
}

/**
 * Fetch a remote actor's profile document for display info.
 * Returns an empty object on failure — federation should be resilient
 * to unreachable remote servers.
 */
async function fetchActorProfile(actorUrl) {
  try {
    const response = await fetch(actorUrl, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      return await response.json();
    }
  } catch {
    // Remote server unreachable — proceed without profile
  }
  return {};
}

/**
 * Write an activity record to the ap_activities collection.
 * Strips the raw JSON field unless storeRawActivities is enabled,
 * keeping the activity log lightweight for backups.
 */
async function logActivity(collections, context, record) {
  const { raw, ...rest } = record;
  await collections.ap_activities.insertOne({
    ...rest,
    ...(context.storeRawActivities ? { raw } : {}),
    receivedAt: new Date(),
  });
}
