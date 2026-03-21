/**
 * Resolve a remote account via WebFinger + ActivityPub actor fetch.
 * Uses the Fedify federation instance to perform discovery.
 *
 * Shared by accounts.js (lookup) and search.js (resolve=true).
 */
import { serializeAccount } from "../entities/account.js";
import { cacheAccountStats } from "./account-cache.js";

/**
 * @param {string} acct - Account identifier (user@domain or URL)
 * @param {object} pluginOptions - Plugin options with federation, handle, publicationUrl
 * @param {string} baseUrl - Server base URL
 * @returns {Promise<object|null>} Serialized Mastodon Account or null
 */
export async function resolveRemoteAccount(acct, pluginOptions, baseUrl) {
  const { federation, handle, publicationUrl } = pluginOptions;
  if (!federation) return null;

  try {
    const ctx = federation.createContext(
      new URL(publicationUrl),
      { handle, publicationUrl },
    );

    // Determine lookup URI
    let actorUri;
    if (acct.includes("@")) {
      const parts = acct.replace(/^@/, "").split("@");
      const username = parts[0];
      const domain = parts[1];
      if (!username || !domain) return null;
      actorUri = `acct:${username}@${domain}`;
    } else if (acct.startsWith("http")) {
      actorUri = acct;
    } else {
      return null;
    }

    const actor = await ctx.lookupObject(actorUri);
    if (!actor) return null;

    // Extract data from the Fedify actor object
    const name = actor.name?.toString() || actor.preferredUsername?.toString() || "";
    const actorUrl = actor.id?.href || "";
    const username = actor.preferredUsername?.toString() || "";
    const domain = actorUrl ? new URL(actorUrl).hostname : "";
    const summary = actor.summary?.toString() || "";

    // Get avatar
    let avatarUrl = "";
    try {
      const icon = await actor.getIcon();
      avatarUrl = icon?.url?.href || "";
    } catch { /* ignore */ }

    // Get header image
    let headerUrl = "";
    try {
      const image = await actor.getImage();
      headerUrl = image?.url?.href || "";
    } catch { /* ignore */ }

    // Get collection counts (followers, following, outbox)
    let followersCount = 0;
    let followingCount = 0;
    let statusesCount = 0;
    try {
      const followers = await actor.getFollowers();
      if (followers?.totalItems != null) followersCount = followers.totalItems;
    } catch { /* ignore */ }
    try {
      const following = await actor.getFollowing();
      if (following?.totalItems != null) followingCount = following.totalItems;
    } catch { /* ignore */ }
    try {
      const outbox = await actor.getOutbox();
      if (outbox?.totalItems != null) statusesCount = outbox.totalItems;
    } catch { /* ignore */ }

    // Get published/created date
    const published = actor.published
      ? String(actor.published)
      : null;

    // Profile fields from attachments
    const fields = [];
    try {
      for await (const attachment of actor.getAttachments()) {
        if (attachment?.name) {
          fields.push({
            name: attachment.name?.toString() || "",
            value: attachment.value?.toString() || "",
          });
        }
      }
    } catch { /* ignore */ }

    const account = serializeAccount(
      {
        name,
        url: actorUrl,
        photo: avatarUrl,
        handle: `@${username}@${domain}`,
        summary,
        image: headerUrl,
        bot: actor.constructor?.name === "Service" || actor.constructor?.name === "Application",
        attachments: fields.length > 0 ? fields : undefined,
        createdAt: published || undefined,
      },
      { baseUrl },
    );

    // Override counts with real data from AP collections
    account.followers_count = followersCount;
    account.following_count = followingCount;
    account.statuses_count = statusesCount;

    // Cache stats so embedded account objects in statuses can use them
    cacheAccountStats(actorUrl, {
      followersCount,
      followingCount,
      statusesCount,
      createdAt: published || undefined,
    });

    return account;
  } catch (error) {
    console.warn(`[Mastodon API] Remote account resolution failed for ${acct}:`, error.message);
    return null;
  }
}
