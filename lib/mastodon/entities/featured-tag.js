/**
 * Mastodon FeaturedTag entity.
 *
 * Shared by GET /api/v1/featured_tags (the owner's own list) and
 * GET /api/v1/accounts/:id/featured_tags (the same list, viewed on the profile)
 * so the two cannot drift.
 */
import { remoteActorId } from "../helpers/id-mapping.js";

/**
 * @param {Array<{tag: string}>} tags - rows from ap_featured_tags
 * @param {string} publicationUrl
 * @returns {Array<object>}
 */
export function serializeFeaturedTags(tags, publicationUrl) {
  const base = (publicationUrl || "").replace(/\/$/, "");

  return tags.map((t) => ({
    id: remoteActorId(`tag:${t.tag}`),
    name: t.tag,
    url: `${base}/categories/${encodeURIComponent(t.tag)}`,
    statuses_count: 0,
    last_status_at: null,
  }));
}
