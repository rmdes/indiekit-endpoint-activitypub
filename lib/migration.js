/**
 * Mastodon migration utilities.
 *
 * Parses Mastodon data export CSVs and resolves handles via WebFinger
 * to import followers/following into the ActivityPub collections.
 */

/**
 * Parse Mastodon's following_accounts.csv export.
 * Format: "Account address,Show boosts,Notify on new posts,Languages"
 * First row is the header.
 *
 * @param {string} csvText - Raw CSV text
 * @returns {string[]} Array of handles (e.g. ["user@instance.social"])
 */
export function parseMastodonFollowingCsv(csvText) {
  const lines = csvText.trim().split("\n");
  // Skip header row
  return lines
    .slice(1)
    .map((line) => line.split(",")[0].trim())
    .filter((handle) => handle.length > 0 && handle.includes("@"));
}

/**
 * Parse Mastodon's followers CSV or JSON export.
 * Accepts the same CSV format as following, or a JSON array of actor URLs.
 *
 * @param {string} text - Raw CSV or JSON text
 * @returns {string[]} Array of handles or actor URLs
 */
export function parseMastodonFollowersList(text) {
  const trimmed = text.trim();

  // Try JSON first (array of actor URLs)
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      // Fall through to CSV parsing
    }
  }

  // CSV format — same as following
  return parseMastodonFollowingCsv(trimmed);
}

/**
 * Resolve a fediverse handle (user@instance) to an actor URL via WebFinger.
 *
 * @param {string} handle - Handle like "user@instance.social"
 * @returns {Promise<{actorUrl: string, inbox: string, sharedInbox: string, name: string, handle: string} | null>}
 */
export async function resolveHandleViaWebFinger(handle) {
  const [user, domain] = handle.split("@");
  if (!user || !domain) return null;

  try {
    // WebFinger lookup
    const wfUrl = `https://${domain}/.well-known/webfinger?resource=acct:${encodeURIComponent(handle)}`;
    const wfResponse = await fetch(wfUrl, {
      headers: { Accept: "application/jrd+json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!wfResponse.ok) return null;

    const jrd = await wfResponse.json();
    const selfLink = jrd.links?.find(
      (l) => l.rel === "self" && l.type === "application/activity+json",
    );

    if (!selfLink?.href) return null;

    // Fetch actor document for inbox and profile
    const actorResponse = await fetch(selfLink.href, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!actorResponse.ok) return null;

    const actor = await actorResponse.json();
    return {
      actorUrl: actor.id || selfLink.href,
      inbox: actor.inbox || "",
      sharedInbox: actor.endpoints?.sharedInbox || "",
      name: actor.name || actor.preferredUsername || handle,
      handle: actor.preferredUsername || user,
    };
  } catch {
    return null;
  }
}

/**
 * Import a list of handles into the ap_following collection.
 *
 * @param {string[]} handles - Array of handles to import
 * @param {Collection} collection - MongoDB ap_following collection
 * @returns {Promise<{imported: number, failed: number}>}
 */
export async function bulkImportFollowing(handles, collection) {
  let imported = 0;
  let failed = 0;

  for (const handle of handles) {
    const resolved = await resolveHandleViaWebFinger(handle);
    if (!resolved) {
      failed++;
      continue;
    }

    await collection.updateOne(
      { actorUrl: resolved.actorUrl },
      {
        $set: {
          actorUrl: resolved.actorUrl,
          handle: resolved.handle,
          name: resolved.name,
          inbox: resolved.inbox,
          sharedInbox: resolved.sharedInbox,
          followedAt: new Date(),
          source: "import",
        },
      },
      { upsert: true },
    );
    imported++;
  }

  return { imported, failed };
}

/**
 * Import a list of handles/URLs into the ap_followers collection.
 * These are "pending" followers — they'll become real when they
 * re-follow after the Mastodon Move activity.
 *
 * @param {string[]} entries - Array of handles or actor URLs
 * @param {Collection} collection - MongoDB ap_followers collection
 * @returns {Promise<{imported: number, failed: number}>}
 */
export async function bulkImportFollowers(entries, collection) {
  let imported = 0;
  let failed = 0;

  for (const entry of entries) {
    // If it's a URL, store directly; if it's a handle, resolve via WebFinger
    const isUrl = entry.startsWith("http");
    let actorData;

    if (isUrl) {
      actorData = { actorUrl: entry, handle: "", name: entry, inbox: "", sharedInbox: "" };
    } else {
      actorData = await resolveHandleViaWebFinger(entry);
    }

    if (!actorData) {
      failed++;
      continue;
    }

    await collection.updateOne(
      { actorUrl: actorData.actorUrl },
      {
        $set: {
          actorUrl: actorData.actorUrl,
          handle: actorData.handle,
          name: actorData.name,
          inbox: actorData.inbox,
          sharedInbox: actorData.sharedInbox,
          followedAt: new Date(),
          pending: true, // Will be confirmed when they re-follow after Move
        },
      },
      { upsert: true },
    );
    imported++;
  }

  return { imported, failed };
}
