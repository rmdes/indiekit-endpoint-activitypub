/**
 * OpenGraph metadata fetching with concurrency limiting
 * @module og-unfurl
 */

import { unfurl } from "unfurl.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; Indiekit/1.0; +https://getindiekit.com)";
const TIMEOUT_MS = 10000; // 10 seconds per URL
const MAX_CONCURRENT = 3; // Lower than theme's 5 (inbox context)
const MAX_PREVIEWS = 3; // Max previews per post

// Concurrency limiter — prevents overwhelming outbound network
let activeRequests = 0;
const queue = [];

function runNext() {
  if (queue.length === 0 || activeRequests >= MAX_CONCURRENT) return;
  activeRequests++;
  const { resolve: res, fn } = queue.shift();
  fn()
    .then(res)
    .finally(() => {
      activeRequests--;
      runNext();
    });
}

function throttled(fn) {
  return new Promise((res) => {
    queue.push({ resolve: res, fn });
    runNext();
  });
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Check if a URL points to a private/reserved IP or localhost (SSRF protection)
 * @param {string} url - URL to check
 * @returns {boolean} True if URL targets a private network
 */
function isPrivateUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Block non-http(s) schemes
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      return true;
    }

    // Block localhost variants
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }

    // Block private IPv4 ranges
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return true;                    // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true;      // 192.168.0.0/16
      if (a === 169 && b === 254) return true;      // 169.254.0.0/16 (link-local / cloud metadata)
      if (a === 127) return true;                   // 127.0.0.0/8
      if (a === 0) return true;                     // 0.0.0.0/8
    }

    // Block IPv6 private ranges (basic check)
    if (hostname.startsWith("[fc") || hostname.startsWith("[fd") || hostname.startsWith("[fe80")) {
      return true;
    }

    return false;
  } catch {
    return true; // Invalid URL, treat as private
  }
}

/**
 * Extract links from HTML content
 * @param {string} html - Sanitized HTML content
 * @returns {Array<{url: string, classes: string}>} Links with their class attributes
 */
function extractLinks(html) {
  if (!html) return [];

  const links = [];
  // Match complete <a> tags and extract href + class from anywhere in attributes
  const anchorRegex = /<a\s([^>]+)>/gi;

  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const hrefMatch = attrs.match(/href="([^"]+)"/);
    const classMatch = attrs.match(/class="([^"]+)"/);
    if (hrefMatch) {
      links.push({ url: hrefMatch[1], classes: classMatch ? classMatch[1] : "" });
    }
  }

  return links;
}

/**
 * Check if URL is likely an ActivityPub object or media file
 * @param {string} url - URL to check
 * @returns {boolean} True if URL should be skipped
 */
function shouldSkipUrl(url) {
  try {
    const urlObj = new URL(url);

    // SSRF protection — skip private/internal URLs
    if (isPrivateUrl(url)) {
      return true;
    }

    // Skip media extensions
    const mediaExtensions = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|mp3|wav|ogg)$/i;
    if (mediaExtensions.test(urlObj.pathname)) {
      return true;
    }

    // Skip common AP object patterns (heuristic - not exhaustive)
    const apPatterns = [
      /\/@[\w.-]+\/\d+/, // Mastodon /@user/12345
      /\/@[\w.-]+\/statuses\/[\w]+/, // GoToSocial /@user/statuses/id
      /\/users\/[\w.-]+\/statuses\/\d+/, // Mastodon/Pleroma /users/user/statuses/12345
      /\/objects\/[\w-]+/, // Pleroma/Akkoma /objects/uuid
      /\/notice\/[\w]+/, // Pleroma /notice/id
      /\/notes\/[\w]+/, // Misskey /notes/id
    ];

    return apPatterns.some((pattern) => pattern.test(urlObj.pathname));
  } catch {
    return true; // Invalid URL, skip
  }
}

/**
 * Fetch OpenGraph metadata for external links in HTML content
 * @param {string} html - Sanitized HTML content
 * @returns {Promise<Array<{url: string, title: string, description: string, image: string, favicon: string, domain: string, fetchedAt: string}>>} Link preview objects
 */
export async function fetchLinkPreviews(html) {
  if (!html) return [];

  const links = extractLinks(html);

  // Filter links
  const urlsToFetch = links
    .filter((link) => {
      // Skip mention links (class="mention")
      if (link.classes.includes("mention")) return false;

      // Skip hashtag links (class="hashtag")
      if (link.classes.includes("hashtag")) return false;

      // Skip AP object URLs and media files
      if (shouldSkipUrl(link.url)) return false;

      return true;
    })
    .map((link) => link.url)
    .filter((url, index, self) => self.indexOf(url) === index) // Dedupe
    .slice(0, MAX_PREVIEWS); // Cap at max

  if (urlsToFetch.length === 0) return [];

  // Fetch metadata for each URL (throttled)
  const previews = await Promise.all(
    urlsToFetch.map(async (url) => {
      const metadata = await throttled(async () => {
        try {
          return await unfurl(url, {
            timeout: TIMEOUT_MS,
            headers: { "User-Agent": USER_AGENT },
          });
        } catch (error) {
          console.warn(`[og-unfurl] Failed to fetch ${url}: ${error.message}`);
          return null;
        }
      });

      if (!metadata) return null;

      const og = metadata.open_graph || {};
      const tc = metadata.twitter_card || {};

      const title = og.title || tc.title || metadata.title || extractDomain(url);
      const description = og.description || tc.description || metadata.description || "";
      const image = og.images?.[0]?.url || tc.images?.[0]?.url || null;
      const favicon = metadata.favicon || null;
      const domain = extractDomain(url);

      // Truncate description
      const maxDesc = 160;
      const desc =
        description.length > maxDesc
          ? description.slice(0, maxDesc).trim() + "\u2026"
          : description;

      return {
        url,
        title,
        description: desc,
        image,
        favicon,
        domain,
        fetchedAt: new Date().toISOString(),
      };
    }),
  );

  // Filter out failed fetches (null results)
  return previews.filter((preview) => preview !== null);
}

/**
 * Fetch link previews and store them on a timeline item
 * Fire-and-forget — caller does NOT await. Errors are caught and logged.
 * @param {object} collections - MongoDB collections
 * @param {string} uid - Timeline item UID
 * @param {string} html - Post content HTML
 * @returns {Promise<void>}
 */
export async function fetchAndStorePreviews(collections, uid, html) {
  try {
    const linkPreviews = await fetchLinkPreviews(html);

    await collections.ap_timeline.updateOne(
      { uid },
      { $set: { linkPreviews } },
    );
  } catch (error) {
    // Fire-and-forget — log errors but don't throw
    console.error(
      `[og-unfurl] Failed to store previews for ${uid}: ${error.message}`,
    );
  }
}
