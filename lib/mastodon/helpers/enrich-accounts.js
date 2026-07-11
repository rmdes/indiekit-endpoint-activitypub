/**
 * Enrich embedded account objects in serialized statuses with real
 * follower/following/post counts from remote AP collections — and repair
 * degraded identities (URL-derived numeric usernames from actors that
 * couldn't be fetched at ingest, e.g. Authorized-Fetch servers).
 *
 * Applies cached stats immediately. Uncached accounts are resolved
 * in the background (fire-and-forget) and will be populated for
 * subsequent requests.
 */
import { getCachedAccountStats } from "./account-cache.js";
import { resolveRemoteAccount } from "./resolve-account.js";

/** All-digits username = URL-derived placeholder from an unresolvable actor. */
function isDegradedUsername(username) {
  return /^\d+$/.test(String(username || ""));
}

/**
 * Enrich account objects in a list of serialized statuses.
 * Applies cached stats synchronously. Uncached accounts are resolved
 * in the background for future requests.
 *
 * @param {Array} statuses - Serialized Mastodon Status objects (mutated in place)
 * @param {object} pluginOptions - Plugin options with federation context
 * @param {string} baseUrl - Server base URL
 * @param {object} [collections] - MongoDB collections; when provided, repaired
 *   identities are also persisted back to ap_timeline author docs.
 */
export async function enrichAccountStats(statuses, pluginOptions, baseUrl, collections) {
  if (!statuses?.length || !pluginOptions?.federation) return;

  const uncachedUrls = [];

  for (const status of statuses) {
    applyCachedOrCollect(status.account, uncachedUrls);
    if (status.reblog?.account) {
      applyCachedOrCollect(status.reblog.account, uncachedUrls);
    }
  }

  // Fire-and-forget background enrichment for uncached accounts.
  // Next request will pick up the cached results.
  if (uncachedUrls.length > 0) {
    resolveInBackground(uncachedUrls, pluginOptions, baseUrl, collections);
  }
}

/**
 * Apply cached stats to an account, or collect its URL for background resolution.
 * @param {object} account - Account object to enrich
 * @param {string[]} uncachedUrls - Array to collect uncached URLs into
 */
function applyCachedOrCollect(account, uncachedUrls) {
  if (!account?.url) return;

  const degraded = isDegradedUsername(account.username);
  const cached = getCachedAccountStats(account.url);

  // Identity repair applies regardless of counts
  if (degraded && cached?.username) {
    account.username = cached.username;
    if (cached.acct) account.acct = cached.acct;
    if (cached.displayName && (!account.display_name || isDegradedUsername(account.display_name))) {
      account.display_name = cached.displayName;
    }
    if (cached.avatar && (!account.avatar || account.avatar.endsWith("/default-avatar.svg"))) {
      account.avatar = cached.avatar;
      account.avatar_static = cached.avatar;
    }
  }

  // Already has real counts — but still resolve degraded identities in background
  if (account.followers_count > 0 || account.statuses_count > 0) {
    if (degraded && !cached?.username && !uncachedUrls.includes(account.url)) {
      uncachedUrls.push(account.url);
    }
    return;
  }

  if (cached) {
    account.followers_count = cached.followersCount || 0;
    account.following_count = cached.followingCount || 0;
    account.statuses_count = cached.statusesCount || 0;
    if (cached.createdAt) account.created_at = cached.createdAt;
    return;
  }

  if (!uncachedUrls.includes(account.url)) {
    uncachedUrls.push(account.url);
  }
}

/**
 * Resolve accounts in background. Fire-and-forget — errors are silently ignored.
 * resolveRemoteAccount() populates the account cache as a side effect.
 * When a resolution recovers a real username for a degraded author, the stored
 * ap_timeline author docs are repaired durably (fixes the native reader too).
 * @param {string[]} urls - Actor URLs to resolve
 * @param {object} pluginOptions - Plugin options
 * @param {string} baseUrl - Server base URL
 * @param {object} [collections] - MongoDB collections for durable author repair
 */
function resolveInBackground(urls, pluginOptions, baseUrl, collections) {
  const unique = [...new Set(urls)];
  const CONCURRENCY = 5;

  (async () => {
    for (let i = 0; i < unique.length; i += CONCURRENCY) {
      const batch = unique.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (url) => {
          const account = await resolveRemoteAccount(url, pluginOptions, baseUrl);
          // Durable repair: fix stored authors whose name is the numeric placeholder
          if (account && !isDegradedUsername(account.username) && collections?.ap_timeline) {
            await collections.ap_timeline.updateMany(
              { "author.url": url, "author.name": { $regex: "^[0-9]+$" } },
              {
                $set: {
                  "author.name": account.display_name || account.username,
                  "author.handle": `@${account.acct}`,
                  ...(account.avatar && !account.avatar.endsWith("/default-avatar.svg")
                    ? { "author.photo": account.avatar }
                    : {}),
                },
              },
            ).catch(() => {});
          }
        }),
      );
    }
  })().catch(() => {});
}
