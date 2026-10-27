/**
 * OpenGraph metadata fetching with concurrency limiting
 * @module og-unfurl
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { unfurl } from "unfurl.js";
import { extractObjectData } from "./timeline-store.js";
import { lookupWithSecurity } from "./lookup-helpers.js";

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
 * Get the IPv4 address inside an IPv4-mapped IPv6 address.
 * `new URL()` normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so both
 * the dotted and the hex form must be recognised.
 * @param {string} ip - IPv6 address, lowercase
 * @returns {string|null} IPv4 address, or null if not IPv4-mapped
 */
function mappedIPv4(ip) {
  const match = ip.match(/^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(.+)$/);
  if (!match) return null;
  if (isIP(match[1]) === 4) return match[1];

  const hex = match[1].match(/^([\da-f]{1,4}):([\da-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Check if an IP address is in a private/reserved range.
 * @param {string} ip - IPv4 or IPv6 address
 * @returns {boolean} True if private/reserved
 */
export function isPrivateIP(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true;                         // 127.0.0.0/8
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local)
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true;   // 192.0.0.0/24 (IETF)
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
    if (a >= 224) return true;                          // multicast, reserved, broadcast
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    const v4 = mappedIPv4(lower);
    if (v4) return isPrivateIP(v4);
    if (lower === "::" || lower === "::1") return true;                  // unspecified, loopback
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;   // ULA
    if (/^fe[89ab]/.test(lower)) return true;                            // link-local fe80::/10
    return false;
  }
  return true; // Not an IP address at all
}

/**
 * Check if a URL resolves to a private/reserved IP (SSRF protection).
 * Performs DNS resolution to defeat DNS rebinding attacks.
 * @param {string} url - URL to check
 * @returns {Promise<boolean>} True if URL targets a private network
 */
async function isPrivateResolved(url) {
  try {
    const urlObj = new URL(url);

    // Block non-http(s) schemes
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      return true;
    }

    const hostname = urlObj.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // Block obvious localhost variants
    if (hostname === "localhost") return true;

    // If hostname is already an IP, check directly (no DNS needed)
    if (isIP(hostname)) return isPrivateIP(hostname);

    // DNS resolution — check every resolved IP, not just the first
    const addresses = await lookup(hostname, { all: true });
    return addresses.length === 0 || addresses.some(({ address }) => isPrivateIP(address));
  } catch {
    return true; // DNS failure or invalid URL — treat as private
  }
}

const MAX_REDIRECTS = 5;

/**
 * Fetch a URL, checking every redirect hop against private addresses.
 *
 * Given to unfurl as its `fetch`, so the page request and the oEmbed request
 * a page points to both go through it. Without it unfurl follows up to 50
 * redirects itself, so only the first URL was ever checked.
 *
 * ponytail: the address is checked by its own DNS lookup, then fetch resolves
 * it again, so a rebinding DNS server can still answer differently in between.
 * Pin the checked address in an undici dispatcher (`connect.lookup`) if that
 * window matters.
 * @param {string} url - URL to fetch
 * @returns {Promise<Response>} Response of the final, non-redirect hop
 */
export async function guardedFetch(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (await isPrivateResolved(current)) {
      throw new Error(`Refusing to fetch private address ${current}`);
    }

    const response = await fetch(current, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }

    await response.body?.cancel();
    current = new URL(location, current).href;
  }
  throw new Error(`Too many redirects fetching ${url}`);
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
 * @returns {Promise<boolean>} True if URL should be skipped
 */
async function shouldSkipUrl(url) {
  try {
    const urlObj = new URL(url);

    // SSRF protection — skip private/internal URLs
    if (await isPrivateResolved(url)) {
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

  // Filter links — async because shouldSkipUrl performs DNS resolution
  const filterResults = await Promise.all(
    links.map(async (link) => {
      // Skip mention links (class="mention")
      if (link.classes.includes("mention")) return false;

      // Skip hashtag links (class="hashtag")
      if (link.classes.includes("hashtag")) return false;

      // Skip AP object URLs and media files
      if (await shouldSkipUrl(link.url)) return false;

      return true;
    }),
  );

  const urlsToFetch = links
    .filter((_, index) => filterResults[index])
    .map((link) => link.url)
    .filter((url, index, self) => self.indexOf(url) === index) // Dedupe
    .slice(0, MAX_PREVIEWS); // Cap at max

  if (urlsToFetch.length === 0) return [];

  // Fetch metadata for each URL (throttled)
  const previews = await Promise.all(
    urlsToFetch.map(async (url) => {
      const metadata = await throttled(async () => {
        try {
          return await unfurl(url, { fetch: guardedFetch });
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

/**
 * Fetch a quoted post's data and store it on the timeline item.
 * Fire-and-forget — caller does NOT await. Errors are caught and logged.
 * @param {object} collections - MongoDB collections
 * @param {string} uid - Timeline item UID (the quoting post)
 * @param {string} quoteUrl - URL of the quoted post
 * @param {object} ctx - Fedify context (for lookupObject)
 * @param {object} documentLoader - Authenticated DocumentLoader
 * @returns {Promise<void>}
 */
export async function fetchAndStoreQuote(collections, uid, quoteUrl, ctx, documentLoader) {
  try {
    const object = await lookupWithSecurity(ctx,new URL(quoteUrl), { documentLoader });
    if (!object) return;

    const quoteData = await extractObjectData(object, { documentLoader });

    // If author photo is empty, try fetching the actor directly
    if (!quoteData.author.photo && quoteData.author.url) {
      try {
        const actor = await lookupWithSecurity(ctx,new URL(quoteData.author.url), { documentLoader });
        if (actor) {
          const { extractActorInfo } = await import("./timeline-store.js");
          const actorInfo = await extractActorInfo(actor, { documentLoader });
          if (actorInfo.photo) {
            quoteData.author.photo = actorInfo.photo;
          }
        }
      } catch {
        // Actor fetch failed — keep existing author data
      }
    }

    const quote = {
      url: quoteData.url || quoteData.uid,
      uid: quoteData.uid,
      author: quoteData.author,
      content: quoteData.content,
      published: quoteData.published,
      name: quoteData.name,
      photo: quoteData.photo?.slice(0, 1) || [],
    };

    // Strip the "RE: <link>" paragraph from the parent post's content
    // Mastodon adds this as: <p>RE: <a href="QUOTE_URL">...</a></p>
    const update = { $set: { quote } };
    const parentItem = await collections.ap_timeline.findOne({ uid });
    if (parentItem?.content?.html) {
      const cleaned = stripQuoteReferenceHtml(parentItem.content.html, quoteUrl);
      if (cleaned !== parentItem.content.html) {
        update.$set["content.html"] = cleaned;
      }
    }

    await collections.ap_timeline.updateOne({ uid }, update);
  } catch (error) {
    console.error(`[og-unfurl] Failed to fetch quote for ${uid}: ${error.message}`);
  }
}

/**
 * Strip the "RE: <link>" paragraph that Mastodon adds for quoted posts.
 * Removes <p> elements containing "RE:" followed by a link to the quote URL.
 * @param {string} html - Content HTML
 * @param {string} quoteUrl - URL of the quoted post
 * @returns {string} Cleaned HTML
 */
export function stripQuoteReferenceHtml(html, quoteUrl) {
  if (!html || !quoteUrl) return html;
  // Match <p> containing "RE:" and a link whose href contains the quote domain+path
  // Mastodon uses both /users/X/statuses/Y and /@X/Y URL formats
  try {
    const quoteUrlObj = new URL(quoteUrl);
    const quoteDomain = quoteUrlObj.hostname;
    // Escape special regex chars in domain
    const domainEscaped = quoteDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match <p>RE: <a href="...DOMAIN...">...</a></p> (with optional whitespace)
    const re = new RegExp(
      `<p>\\s*RE:\\s*<a\\s[^>]*href="[^"]*${domainEscaped}[^"]*"[^>]*>.*?</a>\\s*</p>`,
      "i",
    );
    return html.replace(re, "").trim();
  } catch {
    return html;
  }
}
