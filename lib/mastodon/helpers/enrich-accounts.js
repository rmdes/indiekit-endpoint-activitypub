/**
 * Enrich embedded account objects in serialized statuses with real
 * follower/following/post counts from remote AP collections.
 *
 * Phanpy (and some other clients) never call /accounts/:id — they
 * trust the account object embedded in each status. Without enrichment,
 * these show 0/0/0 for all remote accounts.
 *
 * Uses the account stats cache to avoid redundant fetches. Only resolves
 * unique authors with 0 counts that aren't already cached.
 */
import { getCachedAccountStats } from "./account-cache.js";
import { resolveRemoteAccount } from "./resolve-account.js";

/**
 * Enrich account objects in a list of serialized statuses.
 * Resolves unique authors in parallel (max 5 concurrent).
 *
 * @param {Array} statuses - Serialized Mastodon Status objects (mutated in place)
 * @param {object} pluginOptions - Plugin options with federation context
 * @param {string} baseUrl - Server base URL
 */
export async function enrichAccountStats(statuses, pluginOptions, baseUrl) {
  if (!statuses?.length || !pluginOptions?.federation) return;

  // Collect unique author URLs that need enrichment
  const accountsToEnrich = new Map(); // url -> [account references]
  for (const status of statuses) {
    collectAccount(status.account, accountsToEnrich);
    if (status.reblog?.account) {
      collectAccount(status.reblog.account, accountsToEnrich);
    }
  }

  if (accountsToEnrich.size === 0) return;

  // Resolve in parallel with concurrency limit
  const entries = [...accountsToEnrich.entries()];
  const CONCURRENCY = 5;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async ([url, accounts]) => {
        try {
          const resolved = await resolveRemoteAccount(url, pluginOptions, baseUrl);
          if (resolved) {
            for (const account of accounts) {
              account.followers_count = resolved.followers_count;
              account.following_count = resolved.following_count;
              account.statuses_count = resolved.statuses_count;
              if (resolved.created_at && account.created_at) {
                account.created_at = resolved.created_at;
              }
              if (resolved.note) account.note = resolved.note;
              if (resolved.fields?.length) account.fields = resolved.fields;
              if (resolved.avatar && resolved.avatar !== account.avatar) {
                account.avatar = resolved.avatar;
                account.avatar_static = resolved.avatar;
              }
              if (resolved.header) {
                account.header = resolved.header;
                account.header_static = resolved.header;
              }
            }
          }
        } catch {
          // Silently skip failed resolutions
        }
      }),
    );
  }
}

/**
 * Collect an account reference for enrichment if it has 0 counts
 * and isn't already cached.
 */
function collectAccount(account, map) {
  if (!account?.url) return;
  if (account.followers_count > 0 || account.statuses_count > 0) return;

  // Check cache first — if cached, apply immediately
  const cached = getCachedAccountStats(account.url);
  if (cached) {
    account.followers_count = cached.followersCount || 0;
    account.following_count = cached.followingCount || 0;
    account.statuses_count = cached.statusesCount || 0;
    if (cached.createdAt) account.created_at = cached.createdAt;
    return;
  }

  // Queue for remote resolution
  if (!map.has(account.url)) {
    map.set(account.url, []);
  }
  map.get(account.url).push(account);
}
