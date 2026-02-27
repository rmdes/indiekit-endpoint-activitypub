/**
 * FediDB API client with MongoDB caching.
 *
 * Wraps https://api.fedidb.org/v1/ endpoints:
 * - /servers?q=... — search known fediverse instances
 * - /popular-accounts — top accounts by follower count
 *
 * Responses are cached in ap_kv to avoid hitting the API on every keystroke.
 * Cache TTL: 24 hours for both datasets.
 */

const API_BASE = "https://api.fedidb.org/v1";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch with timeout helper.
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get cached data from ap_kv, or null if expired/missing.
 * @param {object} kvCollection - MongoDB ap_kv collection
 * @param {string} cacheKey - Key to look up
 * @returns {Promise<object|null>} Cached data or null
 */
async function getFromCache(kvCollection, cacheKey) {
  if (!kvCollection) return null;
  try {
    const doc = await kvCollection.findOne({ _id: cacheKey });
    if (!doc?.value?.data) return null;
    const age = Date.now() - (doc.value.cachedAt || 0);
    if (age > CACHE_TTL_MS) return null;
    return doc.value.data;
  } catch {
    return null;
  }
}

/**
 * Write data to ap_kv cache.
 * @param {object} kvCollection - MongoDB ap_kv collection
 * @param {string} cacheKey - Key to store under
 * @param {object} data - Data to cache
 */
async function writeToCache(kvCollection, cacheKey, data) {
  if (!kvCollection) return;
  try {
    await kvCollection.updateOne(
      { _id: cacheKey },
      { $set: { value: { data, cachedAt: Date.now() } } },
      { upsert: true }
    );
  } catch {
    // Cache write failure is non-critical
  }
}

/**
 * Get the full FediDB server list (up to 40, the API max).
 * Cached for 24 hours as a single entry. The API ignores query params
 * and always returns the same ranked-by-MAU list, so we fetch once
 * and filter client-side in searchInstances().
 *
 * @param {object} kvCollection - MongoDB ap_kv collection
 * @returns {Promise<Array>}
 */
async function getAllServers(kvCollection) {
  const cacheKey = "fedidb:servers-all";
  const cached = await getFromCache(kvCollection, cacheKey);
  if (cached) return cached;

  try {
    const url = `${API_BASE}/servers?limit=40`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];

    const json = await res.json();
    const servers = json.data || [];

    const results = servers.map((s) => ({
      domain: s.domain,
      software: s.software?.name || "Unknown",
      description: s.description || "",
      mau: s.stats?.monthly_active_users || 0,
      userCount: s.stats?.user_count || 0,
      openRegistration: s.open_registration || false,
    }));

    await writeToCache(kvCollection, cacheKey, results);
    return results;
  } catch {
    return [];
  }
}

/**
 * Search FediDB for instances matching a query.
 * Returns a flat array of { domain, software, description, mau, openRegistration }.
 *
 * Fetches the full server list once (cached 24h) and filters by domain/software match.
 * FediDB's /v1/servers endpoint ignores the `q` param and always returns a static
 * ranked list, so server-side filtering is the only way to get relevant results.
 *
 * @param {object} kvCollection - MongoDB ap_kv collection
 * @param {string} query - Search term (e.g. "mast")
 * @param {number} [limit=10] - Max results
 * @returns {Promise<Array>}
 */
export async function searchInstances(kvCollection, query, limit = 10) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];

  const allServers = await getAllServers(kvCollection);

  return allServers
    .filter(
      (s) =>
        s.domain.toLowerCase().includes(q) ||
        s.software.toLowerCase().includes(q),
    )
    .slice(0, limit);
}

/**
 * Check if a remote instance supports unauthenticated public timeline access.
 * Makes a lightweight HEAD-like request (limit=1) to the Mastodon public timeline API.
 *
 * Cached per domain for 24 hours.
 *
 * @param {object} kvCollection - MongoDB ap_kv collection
 * @param {string} domain - Instance hostname
 * @returns {Promise<{ supported: boolean, error: string|null }>}
 */
export async function checkInstanceTimeline(kvCollection, domain) {
  const cacheKey = `fedidb:timeline-check:${domain}`;
  const cached = await getFromCache(kvCollection, cacheKey);
  if (cached) return cached;

  try {
    const url = `https://${domain}/api/v1/timelines/public?local=true&limit=1`;
    const res = await fetchWithTimeout(url);

    let result;
    if (res.ok) {
      result = { supported: true, error: null };
    } else {
      let errorMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) errorMsg = body.error;
      } catch {
        // Can't parse body
      }
      result = { supported: false, error: errorMsg };
    }

    await writeToCache(kvCollection, cacheKey, result);
    return result;
  } catch {
    return { supported: false, error: "Connection failed" };
  }
}

/**
 * Fetch popular fediverse accounts from FediDB.
 * Returns a flat array of { username, name, domain, handle, url, avatar, followers, bio }.
 *
 * Cached for 24 hours (single cache entry).
 *
 * @param {object} kvCollection - MongoDB ap_kv collection
 * @param {number} [limit=50] - Max accounts to fetch
 * @returns {Promise<Array>}
 */
export async function getPopularAccounts(kvCollection, limit = 50) {
  const cacheKey = `fedidb:popular-accounts:${limit}`;
  const cached = await getFromCache(kvCollection, cacheKey);
  if (cached) return cached;

  try {
    const url = `${API_BASE}/popular-accounts?limit=${limit}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];

    const json = await res.json();
    const accounts = json.data || [];

    const results = accounts.map((a) => ({
      username: a.username || "",
      name: a.name || a.username || "",
      domain: a.domain || "",
      handle: `@${a.username}@${a.domain}`,
      url: a.account_url || "",
      avatar: a.avatar_url || "",
      followers: a.followers_count || 0,
      bio: (a.bio || "").replace(/<[^>]*>/g, "").slice(0, 120),
    }));

    await writeToCache(kvCollection, cacheKey, results);
    return results;
  } catch {
    return [];
  }
}
