/**
 * Timeline domain logic — the single implementation both surfaces call.
 *
 * Replaces the query halves of:
 *   lib/storage/timeline.js          (reader)
 *   lib/mastodon/routes/timelines.js (Mastodon Client API)
 *   lib/controllers/api-timeline.js  (reader JSON adapter)
 *
 * Contract (plan §3): no Express req/res, no rendering, no serialisation, no
 * HTTP status codes. Plain options in, plain documents out.
 *
 * Ratified decisions this encodes:
 *   DD-1  order by `receivedAt` (ingest), not `published`. `published` is
 *         display metadata. A post that federates in three days late appears
 *         where it arrived, not buried where nobody will see it.
 *   DD-2  cursors are opaque; callers never see an ObjectId.
 *   DD-4  followers-only (`private`) posts appear on the home timeline for
 *         BOTH surfaces. Only `direct` is excluded there.
 *
 * @module core/timeline
 */
import { buildPage, decodeCursor, encodeCursor } from "./cursor.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Visibility rules per feed.
 *
 * These are NOT interchangeable — Amendment A/DD-4 is explicit that only the
 * HOME predicate unifies. The public and tag feeds are legitimately narrower,
 * and flattening them into the home rule would leak followers-only posts into
 * a public view.
 */
const VISIBILITY = {
  home: { $nin: ["direct"] },
  public: "public",
  tag: { $in: ["public", "unlisted"] },
};

/**
 * Clamp a caller-supplied limit.
 *
 * Exposed as a parameter rather than hardcoded (F-2): the Mastodon adapter
 * parses `?limit`, the reader supplies its own page size. Neither gets to bake
 * a number into a controller.
 */
export function clampLimit(raw, fallback = DEFAULT_LIMIT) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Build the base filter for a feed, before pagination.
 *
 * @param {object} options
 * @param {"home"|"public"|"tag"} [options.feed="home"]
 * @param {string} [options.type] - "note" | "article" | "boost"
 * @param {boolean} [options.excludeReplies]
 * @param {string} [options.authorUrl]
 * @param {string} [options.tag]
 * @param {boolean} [options.unreadOnly]
 * @param {boolean} [options.includeContext] - Include thread-context ancestors
 * @param {boolean} [options.onlyMedia]
 * @param {string} [options.localAuthorUrl] - Set with `local`/`remote`
 * @param {"local"|"remote"} [options.origin]
 * @returns {object} MongoDB filter
 */
export function buildTimelineFilter(options = {}) {
  const { feed = "home" } = options;
  const filter = {};

  // Thread-context ancestors are fetched for reconstruction only. They are
  // never part of any feed unless explicitly requested.
  if (!options.includeContext) {
    filter.isContext = { $ne: true };
  }

  filter.visibility = VISIBILITY[feed] ?? VISIBILITY.home;

  if (options.type) {
    filter.type = options.type;
  }

  if (options.excludeReplies) {
    // `{inReplyTo: null}` matches null AND missing in MongoDB; the empty string
    // is a separate legacy shape written by an older ingest path, so all three
    // must be listed or ~1/3 of non-replies disappear.
    filter.inReplyTo = { $in: [null, ""] };
  }

  if (options.authorUrl !== undefined) {
    if (typeof options.authorUrl !== "string") {
      throw new TypeError("authorUrl must be a string");
    }
    filter["author.url"] = options.authorUrl;
  }

  if (options.origin && options.localAuthorUrl) {
    filter["author.url"] =
      options.origin === "local"
        ? options.localAuthorUrl
        : { $ne: options.localAuthorUrl };
  }

  if (options.tag !== undefined) {
    if (typeof options.tag !== "string") {
      throw new TypeError("tag must be a string");
    }
    // Anchored, case-insensitive, regex-escaped. Matches both string and array
    // `category` fields.
    const escaped = options.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.category = { $regex: new RegExp(`^${escaped}$`, "i") };
  }

  if (options.unreadOnly) {
    filter.readAt = null;
  }

  if (options.onlyMedia) {
    filter.$or = [
      { "photo.0": { $exists: true } },
      { "video.0": { $exists: true } },
      { "audio.0": { $exists: true } },
    ];
  }

  return filter;
}

/**
 * Fetch a page of timeline items.
 *
 * @param {object} collections
 * @param {object} [options] - buildTimelineFilter options, plus:
 * @param {number} [options.limit]
 * @param {string} [options.before] - opaque cursor
 * @param {string} [options.after] - opaque cursor
 * @param {string} [options.since] - opaque cursor
 * @returns {Promise<{items: object[], before: string|null, after: string|null}>}
 */
export async function getTimeline(collections, options = {}) {
  const limit = clampLimit(options.limit);
  const base = buildTimelineFilter(options);

  const { filter, sort, reverse } = buildPage(base, options);

  const raw = await collections.ap_timeline
    .find(filter)
    .sort(sort)
    .limit(limit)
    .toArray();

  const items = reverse ? raw.reverse() : raw;

  // `published` is normalised to an ISO string: a Date object reaching a
  // Nunjucks `| date` filter crashes the template. This is the workspace's
  // canonical bug, so core guarantees the shape rather than trusting ingest.
  const normalised = items.map((item) => ({
    ...item,
    published:
      item.published instanceof Date ? item.published.toISOString() : item.published,
  }));

  return {
    items: normalised,
    // A full page implies there may be more; a short page is the end.
    before: normalised.length === limit ? encodeCursor(items.at(-1)) : null,
    after: normalised.length > 0 ? encodeCursor(items[0]) : null,
  };
}

/**
 * Count items newer than a cursor — powers the reader's "new posts" banner.
 *
 * @param {object} collections
 * @param {string} after - opaque cursor
 * @param {object} [options] - buildTimelineFilter options
 * @returns {Promise<number>}
 */
export async function countNewer(collections, after, options = {}) {
  const base = buildTimelineFilter(options);
  const { filter } = buildPage(base, { after });

  if (!filter._id) return 0;

  return collections.ap_timeline.countDocuments(filter);
}

/**
 * Mark items read. Idempotent.
 *
 * DD-3: `readAt` is a nullable timestamp shared by BOTH surfaces, replacing the
 * reader's boolean `read` and the Mastodon lane's boolean `dismissed`. Marking
 * read on the phone marks it read on the desktop.
 *
 * @param {object} collections
 * @param {string[]} uids
 * @returns {Promise<number>} documents newly marked
 */
export async function markRead(collections, uids) {
  if (!uids?.length) return 0;

  const { modifiedCount } = await collections.ap_timeline.updateMany(
    { uid: { $in: uids }, readAt: null },
    { $set: { readAt: new Date().toISOString(), read: true } },
  );

  return modifiedCount;
}

/**
 * Count unread items for a feed.
 *
 * @param {object} collections
 * @param {object} [options] - buildTimelineFilter options
 * @returns {Promise<number>}
 */
export async function countUnread(collections, options = {}) {
  return collections.ap_timeline.countDocuments(
    buildTimelineFilter({ ...options, unreadOnly: true }),
  );
}

/**
 * Fetch one item by its AP object URI.
 *
 * DD-5: the URI (`uid`) is core's identity. Adapters mint their own surface ids
 * from it; core never handles a Mastodon id.
 *
 * @param {object} collections
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
export async function getItem(collections, uid) {
  return collections.ap_timeline.findOne({ $or: [{ uid }, { url: uid }] });
}

/**
 * The local actor's URL, used to split a public timeline into local vs remote.
 *
 * Lives here so adapters do not read ap_profile directly (boundary rule 5.2).
 *
 * @param {object} collections
 * @returns {Promise<string>} the URL, or "" when no profile exists
 */
export async function getLocalActorUrl(collections) {
  if (!collections.ap_profile) return "";
  const profile = await collections.ap_profile.findOne({});
  return profile?.url || "";
}

/**
 * Repair stored author metadata for one actor.
 *
 * Some ingest paths stored a numeric placeholder as the author's name. Once a
 * real account resolves, this rewrites those rows so the timeline stops showing
 * a number where a display name belongs.
 *
 * Lives here rather than in the enrichment helper because it WRITES to
 * ap_timeline, and adapters do not write to collections (boundary rule 5.2).
 *
 * @param {object} collections
 * @param {string} authorUrl
 * @param {object} author - { name, handle, photo }
 * @returns {Promise<number>} rows repaired
 */
export async function repairAuthorMetadata(collections, authorUrl, author) {
  if (!collections?.ap_timeline || !authorUrl || !author?.name) return 0;

  const update = {
    "author.name": author.name,
    "author.handle": author.handle,
  };

  if (author.photo) {
    update["author.photo"] = author.photo;
  }

  const { modifiedCount } = await collections.ap_timeline.updateMany(
    { "author.url": authorUrl, "author.name": { $regex: "^[0-9]+$" } },
    { $set: update },
  );

  return modifiedCount;
}

/**
 * Delete every timeline item from one author.
 *
 * Blocking an actor removes their posts, not just their future ones — the
 * difference between blocking and muting. Lives in core because both surfaces
 * offer a block and neither should own the deletion.
 *
 * @param {object} collections
 * @param {string} authorUrl
 * @returns {Promise<number>} items removed
 */
export async function deleteByAuthor(collections, authorUrl) {
  if (!collections?.ap_timeline || !authorUrl) return 0;

  const { deletedCount } = await collections.ap_timeline.deleteMany({
    "author.url": authorUrl,
  });

  return deletedCount;
}

/**
 * Fetch many timeline items by their AP object URIs.
 *
 * Notifications and bookmark/favourite lists both need to resolve a batch of
 * URIs to items; each had its own loop. Matches on `uid` and `url` because
 * either may be the recorded reference.
 *
 * @param {object} collections
 * @param {string[]} urls
 * @returns {Promise<Map<string, object>>} keyed by BOTH uid and url
 */
export async function getItemsByUrls(collections, urls) {
  const map = new Map();
  const unique = [...new Set((urls || []).filter(Boolean))];

  if (unique.length === 0 || !collections.ap_timeline) return map;

  const items = await collections.ap_timeline
    .find({ $or: [{ uid: { $in: unique } }, { url: { $in: unique } }] })
    .toArray();

  for (const item of items) {
    if (item.uid) map.set(item.uid, item);
    if (item.url) map.set(item.url, item);
  }

  return map;
}

/**
 * Distinct hashtags across the timeline — powers tag search.
 *
 * @param {object} collections
 * @returns {Promise<string[]>}
 */
export async function getDistinctTags(collections) {
  if (!collections.ap_timeline) return [];
  const tags = await collections.ap_timeline.distinct("category");
  return tags.filter((t) => typeof t === "string" && t.length > 0);
}

/**
 * Search stored posts by content, newest first.
 *
 * Regex rather than a text index: the collection is one user's timeline, the
 * corpus is small, and a text index would need maintaining for no measurable
 * gain. Input is escaped — see the tag filter for the same reasoning.
 *
 * @param {object} collections
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @returns {Promise<object[]>}
 */
export async function searchPosts(collections, query, { limit = 20 } = {}) {
  if (typeof query !== "string" || !query.trim() || !collections.ap_timeline) {
    return [];
  }

  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");

  return collections.ap_timeline
    .find({
      isContext: { $ne: true },
      $or: [{ "content.text": re }, { name: re }, { summary: re }],
    })
    .sort({ receivedAt: -1, _id: -1 })
    .limit(clampLimit(limit))
    .toArray();
}

/**
 * Fetch one item by an adapter's opaque id.
 *
 * Separate from getItem, which resolves by AP object URI (DD-5). Adapters
 * addressing rows by their own surface id use this.
 *
 * @param {object} collections
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getItemById(collections, id) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_timeline) return null;

  return collections.ap_timeline.findOne({ _id: objectId });
}
