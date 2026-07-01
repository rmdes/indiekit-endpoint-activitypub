/**
 * Shared item processing pipeline for the ActivityPub reader.
 *
 * Both the reader (inbox-sourced items) and explore (Mastodon API items)
 * flow through these functions. This ensures every enhancement (emoji,
 * quote stripping, moderation, etc.) is implemented once.
 */

import { stripQuoteReferenceHtml } from "./og-unfurl.js";
// Use the hardened replaceCustomEmoji (validates http(s) URL schemes + escapes
// attributes) — the render pipeline processes attacker-controlled remote emoji.
import { replaceCustomEmoji } from "./timeline-store.js";
import { shortenDisplayUrls, collapseHashtagStuffing } from "./content-utils.js";

/**
 * Post-process timeline items for rendering.
 * Called after items are loaded from any source (MongoDB or Mastodon API).
 *
 * @param {Array} items - Timeline items (from DB or Mastodon API mapping)
 * @param {object} [options]
 * @param {object} [options.moderation] - { mutedUrls, mutedKeywords, blockedUrls, filterMode }
 * @param {object} [options.interactionsCol] - MongoDB collection for interaction state
 * @returns {Promise<{ items: Array, interactionMap: object }>}
 */
export async function postProcessItems(items, options = {}) {
  // 1. Moderation filters (muted actors, keywords, blocked actors)
  if (options.moderation) {
    items = applyModerationFilters(items, options.moderation);
  }

  // 2. Strip "RE:" paragraphs from items with quote embeds
  stripQuoteReferences(items);

  // 3. Replace custom emoji shortcodes with <img> tags
  applyCustomEmoji(items);

  // 4. Shorten long URLs and collapse hashtag stuffing in content
  applyContentEnhancements(items);

  // 5. Build interaction map (likes/boosts) — empty when no collection
  const interactionMap = options.interactionsCol
    ? await buildInteractionMap(items, options.interactionsCol)
    : {};

  return { items, interactionMap };
}

/**
 * Apply moderation filters to items.
 * Blocked actors are always hidden. Muted actors/keywords are hidden or
 * marked with a content warning depending on filterMode.
 *
 * @param {Array} items
 * @param {object} moderation
 * @param {string[]} moderation.mutedUrls
 * @param {string[]} moderation.mutedKeywords
 * @param {string[]} moderation.blockedUrls
 * @param {string} moderation.filterMode - "hide" or "warn"
 * @returns {Array}
 */
export function applyModerationFilters(items, { mutedUrls, mutedKeywords, blockedUrls, filterMode }) {
  const blockedSet = new Set(blockedUrls);
  const mutedSet = new Set(mutedUrls);

  if (blockedSet.size === 0 && mutedSet.size === 0 && mutedKeywords.length === 0) {
    return items;
  }

  return items.filter((item) => {
    // Blocked actors are ALWAYS hidden
    if (item.author?.url && blockedSet.has(item.author.url)) {
      return false;
    }

    // Check muted actor
    const isMutedActor = item.author?.url && mutedSet.has(item.author.url);

    // Check muted keywords against content, title, and summary
    let matchedKeyword = null;
    if (mutedKeywords.length > 0) {
      const searchable = [item.content?.text, item.name, item.summary]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (searchable) {
        matchedKeyword = mutedKeywords.find((kw) =>
          searchable.includes(kw.toLowerCase()),
        );
      }
    }

    if (isMutedActor || matchedKeyword) {
      if (filterMode === "warn") {
        // Mark for content warning instead of hiding
        item._moderated = true;
        item._moderationReason = isMutedActor ? "muted_account" : "muted_keyword";
        if (matchedKeyword) {
          item._moderationKeyword = matchedKeyword;
        }
        return true;
      }
      return false;
    }

    return true;
  });
}

/**
 * Strip "RE:" quote reference paragraphs from items that have quote embeds.
 * Mutates items in place.
 *
 * @param {Array} items
 */
export function stripQuoteReferences(items) {
  for (const item of items) {
    const quoteRef = item.quoteUrl || item.quote?.url || item.quote?.uid;
    if (item.quote && quoteRef && item.content?.html) {
      item.content.html = stripQuoteReferenceHtml(item.content.html, quoteRef);
    }
  }
}

/**
 * Replace custom emoji :shortcode: patterns with <img> tags.
 * Handles both content HTML and display names.
 * Mutates items in place.
 *
 * @param {Array} items
 */
function applyCustomEmoji(items) {
  for (const item of items) {
    // Replace emoji in post content
    if (item.emojis?.length && item.content?.html) {
      item.content.html = replaceCustomEmoji(item.content.html, item.emojis);
    }

    // Replace emoji in author display name → stored as author.nameHtml
    const authorEmojis = item.author?.emojis;
    if (authorEmojis?.length && item.author?.name) {
      item.author.nameHtml = replaceCustomEmoji(item.author.name, authorEmojis);
    }

    // Replace emoji in boostedBy display name
    const boostEmojis = item.boostedBy?.emojis;
    if (boostEmojis?.length && item.boostedBy?.name) {
      item.boostedBy.nameHtml = replaceCustomEmoji(item.boostedBy.name, boostEmojis);
    }

    // Replace emoji in quote embed content and author name
    if (item.quote) {
      if (item.quote.emojis?.length && item.quote.content?.html) {
        item.quote.content.html = replaceCustomEmoji(item.quote.content.html, item.quote.emojis);
      }
      const qAuthorEmojis = item.quote.author?.emojis;
      if (qAuthorEmojis?.length && item.quote.author?.name) {
        item.quote.author.nameHtml = replaceCustomEmoji(item.quote.author.name, qAuthorEmojis);
      }
    }
  }
}

/**
 * Shorten long URLs and collapse hashtag-heavy paragraphs in content.
 * Mutates items in place.
 *
 * @param {Array} items
 */
function applyContentEnhancements(items) {
  for (const item of items) {
    if (item.content?.html) {
      item.content.html = shortenDisplayUrls(item.content.html);
      item.content.html = collapseHashtagStuffing(item.content.html);
    }
    if (item.quote?.content?.html) {
      item.quote.content.html = shortenDisplayUrls(item.quote.content.html);
    }
  }
}

/**
 * Build interaction map (likes/boosts) for template rendering.
 * Returns { [uid]: { like: true, boost: true } }.
 *
 * @param {Array} items
 * @param {object} interactionsCol - MongoDB collection
 * @returns {Promise<object>}
 */
export async function buildInteractionMap(items, interactionsCol) {
  const interactionMap = {};
  const lookupUrls = new Set();
  const objectUrlToUid = new Map();

  for (const item of items) {
    const uid = item.uid;
    const displayUrl = item.url || item.originalUrl;

    if (uid) {
      lookupUrls.add(uid);
      objectUrlToUid.set(uid, uid);
    }
    if (displayUrl) {
      lookupUrls.add(displayUrl);
      objectUrlToUid.set(displayUrl, uid || displayUrl);
    }
  }

  if (lookupUrls.size === 0) return interactionMap;

  const interactions = await interactionsCol
    .find({ objectUrl: { $in: [...lookupUrls] } })
    .toArray();

  for (const interaction of interactions) {
    const key = objectUrlToUid.get(interaction.objectUrl) || interaction.objectUrl;
    if (!interactionMap[key]) interactionMap[key] = {};
    interactionMap[key][interaction.type] = true;
  }

  return interactionMap;
}

/**
 * Filter items by tab type (reader-specific).
 *
 * @param {Array} items
 * @param {string} tab - "notes", "articles", "boosts", "replies", "media", "all"
 * @returns {Array}
 */
export function applyTabFilter(items, tab) {
  if (tab === "replies") {
    return items.filter((item) => item.inReplyTo);
  }
  if (tab === "media") {
    return items.filter(
      (item) =>
        (item.photo && item.photo.length > 0) ||
        (item.video && item.video.length > 0) ||
        (item.audio && item.audio.length > 0),
    );
  }
  return items;
}

/**
 * Render items to HTML using ap-item-card.njk.
 * Used by all API endpoints that return pre-rendered card HTML.
 *
 * @param {Array} items
 * @param {object} request - Express request (for app.render)
 * @param {object} templateData - Merged template context (locals, mountPath, csrfToken, interactionMap)
 * @returns {Promise<string>}
 */
export async function renderItemCards(items, request, templateData) {
  const htmlParts = await Promise.all(
    items.map(
      (item) =>
        new Promise((resolve, reject) => {
          request.app.render(
            "partials/ap-item-card.njk",
            { ...templateData, item },
            (err, html) => {
              if (err) reject(err);
              else resolve(html);
            },
          );
        }),
    ),
  );
  return htmlParts.join("");
}

// ─── Moderation data cache ──────────────────────────────────────────────────
let _moderationCache = null;
let _moderationCacheAt = 0;
const MODERATION_CACHE_TTL = 30_000; // 30 seconds

/**
 * Invalidate the moderation data cache.
 * Call this from any write operation that changes muted/blocked data.
 */
export function invalidateModerationCache() {
  _moderationCache = null;
  _moderationCacheAt = 0;
}

/**
 * Load moderation data from MongoDB collections.
 * Results are cached in memory for 30 seconds to avoid redundant queries.
 *
 * @param {object} modCollections - { ap_muted, ap_blocked, ap_profile }
 * @returns {Promise<object>} moderation data for postProcessItems()
 */
export async function loadModerationData(modCollections) {
  if (_moderationCache && Date.now() - _moderationCacheAt < MODERATION_CACHE_TTL) {
    return _moderationCache;
  }

  // Dynamic import to avoid circular dependency
  const { getMutedUrls, getMutedKeywords, getBlockedUrls, getFilterMode } =
    await import("./storage/moderation.js");

  const [mutedUrls, mutedKeywords, blockedUrls, filterMode] = await Promise.all([
    getMutedUrls(modCollections),
    getMutedKeywords(modCollections),
    getBlockedUrls(modCollections),
    getFilterMode(modCollections),
  ]);

  _moderationCache = { mutedUrls, mutedKeywords, blockedUrls, filterMode };
  _moderationCacheAt = Date.now();
  return _moderationCache;
}
