import { getFilters } from "../../core/filters.js";

/**
 * Keyword filter helpers for Mastodon Client API v2.
 *
 * Loads active filters from MongoDB and applies them to serialized
 * Mastodon Status objects, following the v2 filter spec:
 * - filterAction "hide"  → status removed from results
 * - filterAction "warn"  → status kept with `filtered` array attached
 */

/**
 * Strip HTML tags from a string for plain-text keyword matching.
 *
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Compile a regex from a list of keyword documents.
 *
 * Keywords with `wholeWord: true` are wrapped in `\b` word boundaries.
 * Keywords with `wholeWord: false` are matched as plain substrings.
 * Returns null if there are no keywords.
 *
 * @param {Array<{keyword: string, wholeWord: boolean}>} keywords
 * @returns {RegExp|null}
 */
/**
 * Build the regex source for one keyword. For wholeWord, a `\b` boundary is
 * added ONLY on a side where the keyword starts/ends with a word char — an
 * unconditional `\b` makes hashtag/emoji keywords like "#politics" never match
 * (`\b#` requires a word char before `#`, which never occurs). Mirrors Mastodon.
 * @param {{keyword: string, wholeWord: boolean}} kw
 * @returns {string}
 */
function keywordRegexSource(kw) {
  const escaped = kw.keyword.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  if (!kw.wholeWord) return escaped;
  const pre = /^\w/.test(kw.keyword) ? "\\b" : "";
  const post = /\w$/.test(kw.keyword) ? "\\b" : "";
  return `${pre}${escaped}${post}`;
}

function compileKeywordRegex(keywords) {
  if (!keywords || keywords.length === 0) return null;

  const parts = keywords.map(keywordRegexSource);

  return new RegExp(parts.join("|"), "i");
}

/**
 * Load active filters for a given context from MongoDB.
 *
 * Skips expired filters. For each filter, loads its keywords and compiles
 * a single regex from all of them.
 *
 * @param {object} collections - MongoDB collections (must have ap_filters, ap_filter_keywords)
 * @param {string} context - Filter context to match ("home", "public", "notifications", "thread")
 * @returns {Promise<Array<{id: string, title: string, context: string[], filterAction: string, expiresAt: string|null, regex: RegExp|null, keywords: Array}>>}
 */
export async function loadUserFilters(collections, context) {
  // Filters and their keywords come from core; this helper keeps only the
  // regex compilation, which is Mastodon-filter semantics rather than storage.
  const filters = await getFilters(collections);
  if (filters.length === 0) return [];

  const now = new Date().toISOString();

  return filters
    // `context` is stored as an array. The previous query was
    // `.find({ context })`, which in MongoDB matches an array CONTAINING the
    // value — preserved here explicitly so the behaviour is legible.
    .filter((f) => (Array.isArray(f.context) ? f.context.includes(context) : f.context === context))
    .filter((f) => !f.expiresAt || f.expiresAt > now)
    .map((filter) => ({
      id: filter._id.toString(),
      title: filter.title || "",
      context: filter.context || [],
      filterAction: filter.filterAction || "warn",
      expiresAt: filter.expiresAt || null,
      regex: compileKeywordRegex(filter.keywords),
      keywords: filter.keywords || [],
    }));
}

/**
 * Apply compiled filters to an array of serialized Mastodon statuses.
 *
 * - "hide" filters: matching statuses are removed entirely
 * - "warn" filters: matching statuses get a `filtered` array attached
 *
 * @param {Array<object>} statuses - Serialized Mastodon Status objects
 * @param {Array<object>} filters - Compiled filter objects from loadUserFilters()
 * @returns {Array<object>} Processed statuses (hide-matched ones removed)
 */
export function applyFilters(statuses, filters) {
  if (!filters || filters.length === 0) return statuses;

  const result = [];

  for (const status of statuses) {
    // Match against CW + content AND the boosted post's CW + content —
    // otherwise a filtered word slips through via a boost (the common case in
    // a boost-heavy timeline) or hides in the content warning.
    const text = [
      status.spoiler_text,
      status.content,
      status.reblog?.spoiler_text,
      status.reblog?.content,
    ]
      .filter(Boolean)
      .map((t) => stripHtml(t))
      .join(" ");
    let hidden = false;

    for (const filter of filters) {
      if (!filter.regex) continue;

      const match = text.match(filter.regex);
      if (!match) continue;

      if (filter.filterAction === "hide") {
        hidden = true;
        break;
      }

      // filterAction === "warn" — attach filtered metadata
      const matchedKeywords = filter.keywords
        .filter((kw) => new RegExp(keywordRegexSource(kw), "i").test(text))
        .map((kw) => kw.keyword);

      if (!status.filtered) {
        status.filtered = [];
      }

      status.filtered.push({
        filter: {
          id: filter.id,
          title: filter.title,
          context: filter.context,
          filter_action: filter.filterAction,
          expires_at: filter.expiresAt,
        },
        keyword_matches: matchedKeywords,
      });
    }

    if (!hidden) {
      result.push(status);
    }
  }

  return result;
}
