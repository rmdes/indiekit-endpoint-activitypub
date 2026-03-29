/**
 * Batch-resolve inReplyTo URLs to Mastodon cursor IDs.
 *
 * Looks up parent posts in ap_timeline by uid/url and returns a Map
 * of inReplyTo URL → cursor ID (milliseconds since epoch as string).
 * Used by route handlers before calling serializeStatus().
 *
 * @param {object} collection - ap_timeline MongoDB collection
 * @param {Array<object>} items - Timeline items with optional inReplyTo
 * @returns {Promise<Map<string, string>>} Map of URL → cursor ID
 */
import { encodeCursor } from "./pagination.js";

export async function resolveReplyIds(collection, items) {
  const map = new Map();
  if (!collection || !items?.length) return map;

  // Collect unique inReplyTo URLs
  const urls = [
    ...new Set(
      items
        .map((item) => item.inReplyTo)
        .filter(Boolean),
    ),
  ];
  if (urls.length === 0) return map;

  // Batch lookup parents by uid or url
  const parents = await collection
    .find({ $or: [{ uid: { $in: urls } }, { url: { $in: urls } }] })
    .project({ uid: 1, url: 1, published: 1 })
    .toArray();

  for (const parent of parents) {
    const cursorId = encodeCursor(parent.published);
    if (cursorId && cursorId !== "0") {
      // Map both uid and url to the cursor ID
      if (parent.uid) map.set(parent.uid, cursorId);
      if (parent.url && parent.url !== parent.uid) map.set(parent.url, cursorId);
    }
  }

  return map;
}
