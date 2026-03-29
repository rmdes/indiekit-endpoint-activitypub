/**
 * Batch-resolve inReplyTo URLs to Mastodon cursor IDs and account IDs.
 *
 * Looks up parent posts in ap_timeline by uid/url and returns two Maps:
 * - replyIdMap: inReplyTo URL → cursor ID (status ID)
 * - replyAccountIdMap: inReplyTo URL → author account ID
 *
 * Used by route handlers before calling serializeStatus().
 *
 * @param {object} collection - ap_timeline MongoDB collection
 * @param {Array<object>} items - Timeline items with optional inReplyTo
 * @returns {Promise<{replyIdMap: Map<string, string>, replyAccountIdMap: Map<string, string>}>}
 */
import { encodeCursor } from "./pagination.js";
import { remoteActorId } from "./id-mapping.js";

export async function resolveReplyIds(collection, items) {
  const replyIdMap = new Map();
  const replyAccountIdMap = new Map();
  if (!collection || !items?.length) return { replyIdMap, replyAccountIdMap };

  // Collect unique inReplyTo URLs
  const urls = [
    ...new Set(
      items
        .map((item) => item.inReplyTo)
        .filter(Boolean),
    ),
  ];
  if (urls.length === 0) return { replyIdMap, replyAccountIdMap };

  // Batch lookup parents by uid or url
  const parents = await collection
    .find({ $or: [{ uid: { $in: urls } }, { url: { $in: urls } }] })
    .project({ uid: 1, url: 1, published: 1, "author.url": 1 })
    .toArray();

  for (const parent of parents) {
    const cursorId = encodeCursor(parent.published);
    const authorUrl = parent.author?.url;
    const authorAccountId = authorUrl ? remoteActorId(authorUrl) : null;

    const setMaps = (key) => {
      if (cursorId && cursorId !== "0") replyIdMap.set(key, cursorId);
      if (authorAccountId) replyAccountIdMap.set(key, authorAccountId);
    };

    if (parent.uid) setMaps(parent.uid);
    if (parent.url && parent.url !== parent.uid) setMaps(parent.url);
  }

  return { replyIdMap, replyAccountIdMap };
}
