/**
 * Mastodon pagination helpers.
 *
 * Emits RFC 8288 Link headers that Phanpy/Elk/Moshidon parse, from the opaque
 * cursors core returns. The ObjectId-based query builder that used to live here
 * is gone — core owns cursor encoding end to end (DD-2), so no adapter needs
 * to know what a cursor is made of.
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

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
 * Set the Link pagination header from opaque cursors supplied by core.
 *
 * Preferred over setPaginationHeaders() for ported routes: it takes the cursor
 * strings core already returns, so the adapter never reads `_id` off a Mongo
 * document (DD-2 / CI rule 5.2).
 *
 * @param {object} res - Express response
 * @param {object} req - Express request (for building URLs)
 * @param {{before: string|null, after: string|null}} cursors - from core
 */
export function setCursorHeaders(res, req, { before, after } = {}) {
  if (!before && !after) return;

  const baseUrl = `${req.protocol}://${req.get("host")}${req.path}`;

  const carried = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "max_id" || key === "min_id" || key === "since_id") continue;
    if (Array.isArray(value)) {
      for (const v of value) carried.append(key, v);
    } else {
      carried.set(key, String(value));
    }
  }

  const links = [];

  if (before) {
    const next = new URLSearchParams(carried);
    next.set("max_id", before);
    links.push(`<${baseUrl}?${next.toString()}>; rel="next"`);
  }

  if (after) {
    const prev = new URLSearchParams(carried);
    prev.set("min_id", after);
    links.push(`<${baseUrl}?${prev.toString()}>; rel="prev"`);
  }

  res.set("Link", links.join(", "));
}
