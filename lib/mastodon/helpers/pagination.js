/**
 * Mastodon-compatible cursor pagination helpers.
 *
 * Uses `published` date as cursor (chronologically correct) instead of
 * MongoDB ObjectId. ObjectId reflects insertion order, not publication
 * order — backfilled or syndicated posts get new ObjectIds at import
 * time, breaking chronological sort. The `published` field matches the
 * native reader's sort and produces a correct timeline.
 *
 * Cursor values are `published` ISO strings, but Mastodon clients pass
 * them as opaque `max_id`/`min_id`/`since_id` strings. We encode the
 * published date as a Mastodon-style snowflake-ish ID (milliseconds
 * since epoch) so clients treat them as comparable integers.
 *
 * Emits RFC 8288 Link headers that masto.js / Phanpy parse.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

/**
 * Encode a published date string as a numeric cursor ID.
 * Mastodon clients expect IDs to be numeric strings that sort chronologically.
 * We use milliseconds since epoch — monotonic and comparable.
 *
 * @param {string|Date} published - ISO date string or Date object
 * @returns {string} Numeric string (ms since epoch)
 */
export function encodeCursor(published) {
  if (!published) return "0";
  const ms = new Date(published).getTime();
  return Number.isFinite(ms) ? String(ms) : "0";
}

/**
 * Decode a numeric cursor ID back to an ISO date string.
 *
 * @param {string} cursor - Numeric cursor from client
 * @returns {string|null} ISO date string, or null if invalid
 */
export function decodeCursor(cursor) {
  if (!cursor) return null;
  const ms = Number.parseInt(cursor, 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/**
 * Parse and clamp the limit parameter.
 *
 * @param {string|number} raw - Raw limit value from query string
 * @returns {number}
 */
export function parseLimit(raw) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Build a MongoDB filter object for cursor-based pagination.
 *
 * Mastodon cursor params (all optional, applied to `published`):
 *   max_id   — return items older than this cursor (exclusive)
 *   min_id   — return items newer than this cursor (exclusive), closest first
 *   since_id — return items newer than this cursor (exclusive), most recent first
 *
 * @param {object} baseFilter - Existing MongoDB filter to extend
 * @param {object} cursors
 * @param {string} [cursors.max_id] - Numeric cursor (ms since epoch)
 * @param {string} [cursors.min_id] - Numeric cursor (ms since epoch)
 * @param {string} [cursors.since_id] - Numeric cursor (ms since epoch)
 * @returns {{ filter: object, sort: object, reverse: boolean }}
 */
export function buildPaginationQuery(baseFilter, { max_id, min_id, since_id } = {}) {
  const filter = { ...baseFilter };
  let sort = { published: -1 }; // newest first (default)
  let reverse = false;

  if (max_id) {
    const date = decodeCursor(max_id);
    if (date) {
      filter.published = { ...filter.published, $lt: date };
    }
  }

  if (since_id) {
    const date = decodeCursor(since_id);
    if (date) {
      filter.published = { ...filter.published, $gt: date };
    }
  }

  if (min_id) {
    const date = decodeCursor(min_id);
    if (date) {
      filter.published = { ...filter.published, $gt: date };
      // min_id returns results closest to the cursor, so sort ascending
      // then reverse the results before returning
      sort = { published: 1 };
      reverse = true;
    }
  }

  return { filter, sort, reverse };
}

/**
 * Set the Link pagination header on an Express response.
 *
 * @param {object} res - Express response object
 * @param {object} req - Express request object (for building URLs)
 * @param {Array} items - Result items (must have `published`)
 * @param {number} limit - The limit used for the query
 */
export function setPaginationHeaders(res, req, items, limit) {
  if (!items?.length) return;

  // Only emit Link if we got a full page (may have more)
  if (items.length < limit) return;

  const firstCursor = encodeCursor(items[0].published);
  const lastCursor = encodeCursor(items[items.length - 1].published);

  if (firstCursor === "0" || lastCursor === "0") return;

  const baseUrl = `${req.protocol}://${req.get("host")}${req.path}`;

  // Preserve existing query params (like types[] for notifications)
  const existingParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "max_id" || key === "min_id" || key === "since_id") continue;
    if (Array.isArray(value)) {
      for (const v of value) existingParams.append(key, v);
    } else {
      existingParams.set(key, String(value));
    }
  }

  const links = [];

  // rel="next" — older items (max_id = last item's cursor)
  const nextParams = new URLSearchParams(existingParams);
  nextParams.set("max_id", lastCursor);
  links.push(`<${baseUrl}?${nextParams.toString()}>; rel="next"`);

  // rel="prev" — newer items (min_id = first item's cursor)
  const prevParams = new URLSearchParams(existingParams);
  prevParams.set("min_id", firstCursor);
  links.push(`<${baseUrl}?${prevParams.toString()}>; rel="prev"`);

  res.set("Link", links.join(", "));
}
