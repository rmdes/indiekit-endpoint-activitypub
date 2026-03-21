/**
 * XSS HTML sanitizer for Mastodon Client API responses.
 *
 * Strips dangerous HTML while preserving safe markup that
 * Mastodon clients expect (links, paragraphs, line breaks,
 * inline formatting, mentions, hashtags).
 */

/**
 * Allowed HTML tags in Mastodon API content fields.
 * Matches what Mastodon itself permits in status content.
 */
const ALLOWED_TAGS = new Set([
  "a",
  "br",
  "p",
  "span",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
  "pre",
  "code",
  "blockquote",
  "ul",
  "ol",
  "li",
]);

/**
 * Allowed attributes per tag.
 */
const ALLOWED_ATTRS = {
  a: new Set(["href", "rel", "class", "target"]),
  span: new Set(["class"]),
};

/**
 * Sanitize HTML content for safe inclusion in API responses.
 *
 * Strips all tags not in the allowlist and removes disallowed attributes.
 * This is a lightweight sanitizer — for production, consider a
 * battle-tested library like DOMPurify or sanitize-html.
 *
 * @param {string} html - Raw HTML string
 * @returns {string} Sanitized HTML
 */
export function sanitizeHtml(html) {
  if (!html || typeof html !== "string") return "";

  return html.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tagName) => {
    const tag = tagName.toLowerCase();

    // Closing tag
    if (match.startsWith("</")) {
      return ALLOWED_TAGS.has(tag) ? `</${tag}>` : "";
    }

    // Opening tag — check if allowed
    if (!ALLOWED_TAGS.has(tag)) return "";

    // Self-closing br
    if (tag === "br") return "<br>";

    // Strip disallowed attributes
    const allowedAttrs = ALLOWED_ATTRS[tag];
    if (!allowedAttrs) return `<${tag}>`;

    const attrs = [];
    const attrRegex = /([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/gi;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(match)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      if (attrName === tag) continue; // skip tag name itself
      const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
      if (allowedAttrs.has(attrName)) {
        // Block javascript: URIs in href
        if (attrName === "href" && /^\s*javascript:/i.test(attrValue)) continue;
        attrs.push(`${attrName}="${escapeAttr(attrValue)}"`);
      }
    }

    return attrs.length > 0 ? `<${tag} ${attrs.join(" ")}>` : `<${tag}>`;
  });
}

/**
 * Escape HTML attribute value.
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Strip all HTML tags, returning plain text.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html.replace(/<[^>]*>/g, "").trim();
}
