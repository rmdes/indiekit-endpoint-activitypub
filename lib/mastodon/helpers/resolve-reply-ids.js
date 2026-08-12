/**
 * Batch-resolve inReplyTo URLs to ObjectId strings and account IDs.
 *
 * Looks up parent posts in ap_timeline by uid/url and returns two Maps:
 * - replyIdMap: inReplyTo URL → parent _id.toString()
 * - replyAccountIdMap: inReplyTo URL → parent author account ID
 *
 * @param {object} collection - ap_timeline MongoDB collection
 * @param {Array<object>} items - Timeline items with optional inReplyTo
 * @returns {Promise<{replyIdMap: Map<string, string>, replyAccountIdMap: Map<string, string>}>}
 */
import { list } from "../../core/collections-io.js";

import { remoteActorId } from "./id-mapping.js";

export async function resolveReplyIds(collection, items) {
  const replyIdMap = new Map();
  const replyAccountIdMap = new Map();
  if (!collection || !items?.length) return { replyIdMap, replyAccountIdMap };

  const urls = [
    ...new Set(
      items.map((item) => item.inReplyTo).filter(Boolean),
    ),
  ];
  if (urls.length === 0) return { replyIdMap, replyAccountIdMap };

  const parents = await list(collection, {
    filter: { $or: [{ uid: { $in: urls } }, { url: { $in: urls } }] },
    projection: { uid: 1, url: 1, "author.url": 1 },
  });

  for (const parent of parents) {
    const parentId = parent._id.toString();
    const authorUrl = parent.author?.url;
    const authorAccountId = authorUrl ? remoteActorId(authorUrl) : null;

    const setMaps = (key) => {
      replyIdMap.set(key, parentId);
      if (authorAccountId) replyAccountIdMap.set(key, authorAccountId);
    };

    if (parent.uid) setMaps(parent.uid);
    if (parent.url && parent.url !== parent.uid) setMaps(parent.url);
  }

  return { replyIdMap, replyAccountIdMap };
}
