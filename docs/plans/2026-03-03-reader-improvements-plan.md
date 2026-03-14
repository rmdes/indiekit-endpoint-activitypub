# Reader Improvements Plan — Inspired by Elk & Phanpy

**Date:** 2026-03-03
**Source:** `docs/research/2026-03-03-elk-phanpy-comparison.md`
**Current version:** 2.4.5

---

## Overview

Prioritized improvements to the ActivityPub reader, organized into releases. Each release is a publishable npm version. Tasks within a release are ordered by dependency (later tasks may depend on earlier ones).

**Release 0 must ship first** — it unifies the reader and explore pipelines so that every subsequent release only needs to implement each feature once.

---

## Release 0: Unify Reader & Explore Pipeline (v2.5.0-rc.1)

**Impact:** Critical prerequisite — Without this, every improvement from Releases 1-8 must be implemented twice (once for inbox-sourced items, once for Mastodon API items), with different code in different files. This release eliminates that duplication.

### Problem Statement

The reader (followed accounts) and explore (public instance timelines) are the same feature with different data sources. But the code treats them as separate systems:

| Operation | Reader | Explore | Duplicated? |
|-----------|--------|---------|-------------|
| Item construction | `extractObjectData()` in `timeline-store.js` | `mapMastodonStatusToItem()` in `explore-utils.js` | Yes — same shape, different source |
| Quote stripping | `reader.js:200-206` | `explore.js:102-108` AND `explore.js:193-199` | Yes — identical loop in 3 places |
| Moderation filtering | `reader.js:84-146` | (missing) | Explore has none |
| Interaction map | `reader.js:154-198` | `explore.js:134` (empty `{}`) | Different but same pattern |
| Tab filtering | `reader.js:59-82` | N/A | Reader-only |
| Mastodon API fetch | N/A | `explore.js:63-114` AND `explore.js:160-205` | Duplicated within explore itself |
| Card HTML rendering | `api-timeline.js:148-170` | `explore.js:207-229` | Identical |
| Infinite scroll JS | `apInfiniteScroll` (95 lines) | `apExploreScroll` (93 lines) | 80% identical |

Additionally, `reader.js` and `api-timeline.js` duplicate the same logic (moderation, interaction map, tab filtering, quote stripping) — the API endpoint is a copy-paste of the page controller.

### Task 0.1: Extract `postProcessItems()` shared utility

**File:** `lib/item-processing.js` (new)

Extract the shared post-processing that happens after items are loaded (from DB or API), regardless of source. This function takes raw items and returns processed items ready for rendering.

```js
/**
 * Post-process timeline items for rendering.
 * Used by both reader and explore controllers.
 *
 * @param {Array} items - Raw timeline items (from DB or Mastodon API mapping)
 * @param {object} options
 * @param {object} [options.moderation] - { mutedUrls, mutedKeywords, blockedUrls, filterMode }
 * @param {object} [options.interactionsCol] - MongoDB collection for interaction state lookup
 * @returns {{ items: Array, interactionMap: object }}
 */
export async function postProcessItems(items, options = {}) {
  // 1. Apply moderation filters (muted actors, keywords, blocked actors)
  if (options.moderation) {
    items = applyModerationFilters(items, options.moderation);
  }

  // 2. Strip "RE:" paragraphs from items with quote embeds
  stripQuoteReferences(items);

  // 3. Build interaction map (likes, boosts) — empty for explore
  const interactionMap = options.interactionsCol
    ? await buildInteractionMap(items, options.interactionsCol)
    : {};

  return { items, interactionMap };
}
```

This eliminates 4 copies of the quote-stripping loop, 2 copies of the moderation filter, and 2 copies of the interaction map builder.

### Task 0.2: Extract `applyModerationFilters()` into shared utility

**File:** `lib/item-processing.js`

Move the moderation filtering logic from `reader.js:84-146` (and its duplicate in `api-timeline.js:63-111`) into a single function:

```js
export function applyModerationFilters(items, { mutedUrls, mutedKeywords, blockedUrls, filterMode }) {
  const blockedSet = new Set(blockedUrls);
  const mutedSet = new Set(mutedUrls);

  if (blockedSet.size === 0 && mutedSet.size === 0 && mutedKeywords.length === 0) {
    return items;
  }

  return items.filter((item) => {
    if (item.author?.url && blockedSet.has(item.author.url)) return false;
    // ... (existing logic, written once)
  });
}
```

### Task 0.3: Extract `buildInteractionMap()` into shared utility

**File:** `lib/item-processing.js`

Move the interaction map logic from `reader.js:154-198` (and `api-timeline.js:113-136`) into:

```js
export async function buildInteractionMap(items, interactionsCol) {
  const lookupUrls = new Set();
  const objectUrlToUid = new Map();
  for (const item of items) { /* ... existing logic ... */ }
  // Returns { [uid]: { like: true, boost: true } }
}
```

### Task 0.4: Extract `renderItemCards()` shared HTML renderer

**File:** `lib/item-processing.js`

Move the server-side card rendering from `api-timeline.js:148-170` (and identical code in `explore.js:207-229`) into:

```js
/**
 * Render items to HTML using ap-item-card.njk.
 * Used by both timeline API and explore API for infinite scroll.
 */
export async function renderItemCards(items, request, templateData) {
  const htmlParts = await Promise.all(
    items.map((item) => new Promise((resolve, reject) => {
      request.app.render(
        "partials/ap-item-card.njk",
        { ...templateData, item },
        (err, html) => err ? reject(err) : resolve(html),
      );
    })),
  );
  return htmlParts.join("");
}
```

### Task 0.5: Deduplicate Mastodon API fetch in explore controller

**File:** `lib/controllers/explore.js`

`exploreController()` (page load) and `exploreApiController()` (AJAX scroll) have 95% identical fetch logic. Extract:

```js
/**
 * Fetch statuses from a remote Mastodon-compatible instance.
 * @returns {{ items: Array, nextMaxId: string|null }}
 */
async function fetchMastodonTimeline(instance, { scope, hashtag, maxId, limit }) {
  const isLocal = scope === "local";
  let apiUrl;
  if (hashtag) {
    apiUrl = new URL(`https://${instance}/api/v1/timelines/tag/${encodeURIComponent(hashtag)}`);
  } else {
    apiUrl = new URL(`https://${instance}/api/v1/timelines/public`);
  }
  apiUrl.searchParams.set("local", isLocal ? "true" : "false");
  apiUrl.searchParams.set("limit", String(limit));
  if (maxId) apiUrl.searchParams.set("max_id", maxId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const fetchRes = await fetch(apiUrl.toString(), {
    headers: { Accept: "application/json" },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  if (!fetchRes.ok) throw new Error(`Remote returned HTTP ${fetchRes.status}`);
  const statuses = await fetchRes.json();
  if (!Array.isArray(statuses)) throw new Error("Unexpected API response");

  const items = statuses.map((s) => mapMastodonStatusToItem(s, instance));
  const nextMaxId = (statuses.length === limit && statuses.length > 0)
    ? statuses[statuses.length - 1].id
    : null;

  return { items, nextMaxId };
}
```

Both controllers call this instead of duplicating the fetch.

### Task 0.6: Simplify reader controller and API controller

**Files:** `lib/controllers/reader.js`, `lib/controllers/api-timeline.js`

Rewrite both to use `postProcessItems()`:

**reader.js** (before — 70 lines of processing):
```js
const result = await getTimelineItems(collections, options);
let items = applyTabFilter(result.items, tab);

const moderation = await loadModerationData(modCollections);
const { items: processed, interactionMap } = await postProcessItems(items, {
  moderation,
  interactionsCol: application?.collections?.get("ap_interactions"),
});
```

**api-timeline.js** (before — 100 lines of duplicated processing):
```js
const result = await getTimelineItems(collections, options);
let items = applyTabFilter(result.items, tab);

const moderation = await loadModerationData(modCollections);
const { items: processed, interactionMap } = await postProcessItems(items, {
  moderation,
  interactionsCol: application?.collections?.get("ap_interactions"),
});
const html = await renderItemCards(processed, request, { ...response.locals, mountPath, csrfToken, interactionMap });
response.json({ html, before: result.before });
```

### Task 0.7: Simplify explore controllers

**File:** `lib/controllers/explore.js`

Rewrite both `exploreController()` and `exploreApiController()` to use `fetchMastodonTimeline()`, `postProcessItems()`, and `renderItemCards()`:

```js
export function exploreApiController(mountPath) {
  return async (request, response, next) => {
    const instance = validateInstance(request.query.instance);
    if (!instance) return response.status(400).json({ error: "Invalid instance" });

    const { items, nextMaxId } = await fetchMastodonTimeline(instance, {
      scope: request.query.scope,
      hashtag: validateHashtag(request.query.hashtag),
      maxId: request.query.max_id,
      limit: MAX_RESULTS,
    });

    const { items: processed, interactionMap } = await postProcessItems(items);
    const html = await renderItemCards(processed, request, {
      ...response.locals, mountPath, csrfToken: getToken(request.session), interactionMap,
    });

    response.json({ html, maxId: nextMaxId });
  };
}
```

### Task 0.8: Extract `applyTabFilter()` shared utility

**File:** `lib/item-processing.js`

The tab filtering logic is duplicated between `reader.js:71-82` and `api-timeline.js:49-61`:

```js
export function applyTabFilter(items, tab) {
  if (tab === "replies") return items.filter((item) => item.inReplyTo);
  if (tab === "media") return items.filter((item) =>
    item.photo?.length > 0 || item.video?.length > 0 || item.audio?.length > 0
  );
  return items;
}
```

### Task 0.9: Unify infinite scroll Alpine component

**File:** `assets/reader-infinite-scroll.js`

Replace `apExploreScroll` and `apInfiniteScroll` with a single parameterized `apInfiniteScroll` component:

```js
Alpine.data("apInfiniteScroll", () => ({
  loading: false,
  done: false,
  cursor: null,       // Generic cursor — was "maxId" for explore, "before" for reader
  apiUrl: "",         // Set from data-api-url attribute
  cursorParam: "",    // Set from data-cursor-param ("max_id" or "before")
  cursorField: "",    // Response field name for next cursor ("maxId" or "before")
  extraParams: {},    // Additional query params (instance, scope, hashtag, tab, tag)
  observer: null,

  init() {
    const el = this.$el;
    this.cursor = el.dataset.cursor || null;
    this.apiUrl = el.dataset.apiUrl || "";
    this.cursorParam = el.dataset.cursorParam || "before";
    this.cursorField = el.dataset.cursorField || "before";

    // Parse extra params from data-extra-params JSON attribute
    try {
      this.extraParams = JSON.parse(el.dataset.extraParams || "{}");
    } catch { this.extraParams = {}; }

    if (!this.cursor) { this.done = true; return; }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !this.loading && !this.done) {
            this.loadMore();
          }
        }
      },
      { rootMargin: "200px" },
    );

    if (this.$refs.sentinel) this.observer.observe(this.$refs.sentinel);
  },

  async loadMore() {
    if (this.loading || this.done || !this.cursor) return;
    this.loading = true;

    const params = new URLSearchParams({
      [this.cursorParam]: this.cursor,
      ...this.extraParams,
    });

    try {
      const res = await fetch(`${this.apiUrl}?${params}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const timeline = this.$refs.timeline || this.$el.querySelector("[data-timeline]");
      if (data.html && timeline) {
        timeline.insertAdjacentHTML("beforeend", data.html);
      }

      if (data[this.cursorField]) {
        this.cursor = data[this.cursorField];
      } else {
        this.done = true;
        if (this.observer) this.observer.disconnect();
      }
    } catch (err) {
      console.error("[ap-infinite-scroll] load failed:", err.message);
    } finally {
      this.loading = false;
    }
  },

  destroy() {
    if (this.observer) this.observer.disconnect();
  },
}));
```

Template usage for reader:
```njk
<div x-data="apInfiniteScroll"
     data-cursor="{{ before }}"
     data-api-url="{{ mountPath }}/admin/reader/api/timeline"
     data-cursor-param="before"
     data-cursor-field="before"
     data-extra-params='{{ { tab: tab } | dump }}'>
```

Template usage for explore:
```njk
<div x-data="apInfiniteScroll"
     data-cursor="{{ maxId }}"
     data-api-url="{{ mountPath }}/admin/reader/api/explore"
     data-cursor-param="max_id"
     data-cursor-field="maxId"
     data-extra-params='{{ { instance: instance, scope: scope, hashtag: hashtag } | dump }}'>
```

### Task 0.10: Update templates to use unified component

**Files:** `views/activitypub-reader.njk`, `views/activitypub-explore.njk`

Replace `x-data="apExploreScroll"` with `x-data="apInfiniteScroll"` using the parameterized data attributes. Remove the `apExploreScroll` component definition.

### Task 0.11: Verify no regressions

Manual testing:
- Reader timeline loads, infinite scroll works, new posts banner works
- Explore search tab loads, infinite scroll works
- Explore pinned tabs load, load-more buttons work
- Quote embeds render in both views
- Moderation filtering still works in reader
- Interaction state (likes/boosts) still shows in reader
- Read tracking still works

### Files changed

| File | Change |
|------|--------|
| `lib/item-processing.js` | **New** — `postProcessItems()`, `applyModerationFilters()`, `buildInteractionMap()`, `renderItemCards()`, `applyTabFilter()`, `stripQuoteReferences()` |
| `lib/controllers/reader.js` | Simplified — uses `postProcessItems()` |
| `lib/controllers/api-timeline.js` | Simplified — uses `postProcessItems()` + `renderItemCards()` |
| `lib/controllers/explore.js` | Simplified — uses `fetchMastodonTimeline()`, `postProcessItems()`, `renderItemCards()` |
| `assets/reader-infinite-scroll.js` | Unified — single `apInfiniteScroll` component replaces two |
| `views/activitypub-reader.njk` | Updated data attributes for unified scroll component |
| `views/activitypub-explore.njk` | Updated data attributes for unified scroll component |

### Impact on subsequent releases

After Release 0, every improvement only needs to be added in ONE place:

| Enhancement | Before Release 0 | After Release 0 |
|-------------|-------------------|-----------------|
| Custom emoji | `timeline-store.js` + `explore-utils.js` + `reader.js` + `explore.js` | `item-processing.js` (single post-process step) |
| Quote stripping | 4 locations | `item-processing.js` only |
| Moderation | 2 locations | `item-processing.js` only |
| New content transforms | Must add to both pipelines | Single pipeline |

---

## Release 1: Custom Emoji Rendering (v2.5.0)

**Impact:** High — Custom emoji is ubiquitous on the fediverse. Without it, display names show raw `:shortcode:` text and post content loses visual meaning.

### Task 1.1: Store emoji data from ActivityPub inbox

**File:** `lib/timeline-store.js`

`extractObjectData()` currently ignores emoji data. Fedify's `Note`/`Article` objects expose custom emoji via the `getTags()` call — emoji are `Emoji` instances (a subclass of `Flag`) in the tags array, alongside `Hashtag` and `Mention`.

**Changes:**
- In the tag extraction loop (~line 190), check for Fedify `Emoji` instances
- Each Emoji has: `name` (`:shortcode:` with colons), and an `icon` property (an `Image` with `url`)
- Extract to an `emojis` array: `[{ shortcode: "blobcat", url: "https://..." }]`
- Add `emojis` to the returned item object
- Also extract emojis from the actor object in `extractActorInfo()` for display name emoji

**Stored data shape:**
```js
emojis: [
  { shortcode: "blobcat", url: "https://cdn.example/emoji/blobcat.png" },
  { shortcode: "verified", url: "https://cdn.example/emoji/verified.png" }
]
```

### Task 1.2: Store emoji data from Mastodon REST API (explore view)

**File:** `lib/controllers/explore-utils.js`

Mastodon's REST API v1 returns `status.emojis` as an array of `{ shortcode, url, static_url, visible_in_picker }` objects, and `status.account.emojis` for display name emoji.

**Changes:**
- In `mapMastodonStatusToItem()`, extract `status.emojis` → `item.emojis`
- Extract `account.emojis` → `item.author.emojis`
- Normalize to same shape as Task 1.1: `[{ shortcode, url }]`

### Task 1.3: Create emoji replacement utility

**File:** `lib/emoji-utils.js` (new)

A small utility that replaces `:shortcode:` patterns with `<img>` tags. Used in both content HTML and display names.

```js
export function replaceCustomEmoji(html, emojis) {
  if (!emojis?.length) return html;
  for (const emoji of emojis) {
    const pattern = new RegExp(`:${escapeRegex(emoji.shortcode)}:`, "g");
    html = html.replace(pattern,
      `<img src="${emoji.url}" alt=":${emoji.shortcode}:" ` +
      `title=":${emoji.shortcode}:" class="ap-custom-emoji" loading="lazy">`
    );
  }
  return html;
}
```

Must escape regex special characters in shortcodes. Must be called AFTER `sanitizeContent()` (which would strip the `<img>` tags if run after).

### Task 1.4: Apply emoji replacement in content pipeline

**File:** `lib/item-processing.js`

Add an `applyCustomEmoji(items)` step to `postProcessItems()`. Since both reader and explore flow through this single function (after Release 0), emoji replacement happens once for all items regardless of source.

```js
// Inside postProcessItems(), after quote stripping:
applyCustomEmoji(items);
```

The function iterates items, calling `replaceCustomEmoji(item.content.html, item.emojis)` on each.

### Task 1.5: Apply emoji replacement in display names

**File:** `lib/item-processing.js`

Add emoji replacement for display names inside the same `applyCustomEmoji()` step:

```js
if (item.author?.emojis?.length && item.author.name) {
  item.author.nameHtml = replaceCustomEmoji(
    sanitizeHtml(item.author.name, { allowedTags: [], allowedAttributes: {} }),
    item.author.emojis,
  );
}
```

This adds `author.nameHtml` alongside existing `author.name`. Template renders `nameHtml | safe` when present, falls back to `name`.

### Task 1.6: Add emoji CSS

**File:** `assets/reader.css`

```css
.ap-custom-emoji {
  height: 1.2em;
  width: auto;
  vertical-align: middle;
  display: inline;
  margin: 0 0.05em;
}
```

### Task 1.7: Update sanitize-html allowlist

**File:** `lib/timeline-store.js` (or wherever `sanitizeContent` config lives)

The `sanitize-html` configuration must allow `<img>` tags with class `ap-custom-emoji` through — but only for emoji images, not arbitrary remote images. Since emoji replacement happens AFTER sanitization, this isn't an issue: the emoji `<img>` tags are inserted post-sanitization and never pass through the sanitizer.

Verify this ordering is correct in both codepaths (inbox + explore).

### Task 1.8: Store emoji in MongoDB

**File:** `lib/storage/timeline.js`

Add `emojis` to the stored fields in `addTimelineItem()`. Also add `author.emojis` if storing per-author emoji data.

---

## Release 2: Relative Timestamps (v2.5.1)

**Impact:** High — Every fediverse client shows "2m ago" instead of "Feb 25, 2026, 4:46 PM". Relative timestamps are dramatically faster to scan when reading a timeline.

### Task 2.1: Create relative time Alpine directive

**File:** `assets/reader-relative-time.js` (new)

A small Alpine.js directive that:
1. Reads `datetime` attribute from a `<time>` element
2. Computes relative string ("just now", "2m", "1h", "3d", "Feb 25")
3. Updates every 60 seconds for recent posts
4. Shows absolute time on hover via `title` attribute

Format rules (matching Mastodon/Elk conventions):
- < 1 minute: "just now"
- < 60 minutes: "Xm" (e.g., "5m")
- < 24 hours: "Xh" (e.g., "3h")
- < 7 days: "Xd" (e.g., "2d")
- Same year: "Mar 3" (month + day)
- Different year: "Mar 3, 2025" (month + day + year)

No external dependency — pure JS using `Intl.RelativeTimeFormat` or simple math.

### Task 2.2: Apply directive in item card template

**File:** `views/partials/ap-item-card.njk`

Change the timestamp rendering from:
```njk
<time>{{ item.published | date("PPp") }}</time>
```
To:
```njk
<time datetime="{{ item.published }}"
      title="{{ item.published | date('PPp') }}"
      x-data x-relative-time>
  {{ item.published | date("PPp") }}
</time>
```

The server-rendered absolute time remains as fallback (no-JS, initial paint). Alpine enhances it to relative on hydration.

### Task 2.3: Apply to quote embeds and other timestamp locations

**Files:** `views/partials/ap-quote-embed.njk`, `views/activitypub-notifications.njk`, `views/activitypub-activities.njk`

Apply the same `x-relative-time` directive to all timestamp `<time>` elements across the reader UI.

### Task 2.4: Load the directive script

**File:** `views/layouts/ap-reader.njk` (or equivalent layout)

Add `<script src="{{ mountPath }}/assets/reader-relative-time.js"></script>` alongside existing reader scripts. Ensure it loads before Alpine initializes.

---

## Release 3: Enriched Media Data Model (v2.5.2)

**Impact:** High — This is the prerequisite for ALT badges, blurhash placeholders, and focus-point cropping. Currently photos are stored as bare URL strings, losing all metadata.

### Task 3.1: Enrich photo extraction from ActivityPub

**File:** `lib/timeline-store.js`

Change `extractObjectData()` photo extraction from:
```js
photo.push(att.url?.href || "");
```
To:
```js
photo.push({
  url: att.url?.href || "",
  alt: att.name || "",                    // Fedify: Image.name is alt text
  width: att.width || null,               // Fedify: Image.width
  height: att.height || null,             // Fedify: Image.height
  blurhash: "",                           // Not available from AP objects directly
});
```

Fedify's `Image` class (attachment type) exposes `name` (alt text), `width`, `height`, and `url`.

### Task 3.2: Enrich photo extraction from Mastodon API

**File:** `lib/controllers/explore-utils.js`

Mastodon API `media_attachments[]` objects have: `url`, `description` (alt text), `blurhash`, `meta.original.width`, `meta.original.height`, `meta.focus.x`, `meta.focus.y`.

Change from:
```js
photo.push(url);
```
To:
```js
photo.push({
  url,
  alt: att.description || "",
  width: att.meta?.original?.width || null,
  height: att.meta?.original?.height || null,
  blurhash: att.blurhash || "",
  focus: att.meta?.focus || null,         // { x: -0.5..0.5, y: -0.5..0.5 }
});
```

### Task 3.3: Backward-compatible template rendering

**File:** `views/partials/ap-item-media.njk`

Templates currently do `item.photo[0]` expecting a string URL. Must handle both formats during migration:

```njk
{# Support both old string format and new object format #}
{% set photoUrl = photo.url if photo.url else photo %}
{% set photoAlt = photo.alt if photo.alt else "" %}
```

### Task 3.4: Update MongoDB storage

**File:** `lib/storage/timeline.js`

No schema change needed — MongoDB stores whatever shape we give it. But the `getTimelineItems()` function should normalize old string-format photos to objects for template consistency:

```js
// Normalize photo format (backward compat with string-only entries)
photo: (item.photo || []).map(p => typeof p === "string" ? { url: p, alt: "" } : p),
```

### Task 3.5: Update quote embed photo handling

**File:** `lib/og-unfurl.js` (in `fetchAndStoreQuote`)

The quote enrichment stores `quoteData.photo?.slice(0, 1)`. Ensure it works with the new object format.

---

## Release 4: ALT Text Badges (v2.5.3)

**Impact:** High — Accessibility feature that both Elk and Phanpy display prominently. Depends on Release 3.

### Task 4.1: Add ALT badge to media template

**File:** `views/partials/ap-item-media.njk`

For each photo in the grid:
```njk
<div class="ap-media__item">
  <img src="{{ photoUrl }}" alt="{{ photoAlt }}" loading="lazy">
  {% if photoAlt %}
    <button class="ap-media__alt-badge"
            type="button"
            x-data="{ open: false }"
            @click="open = !open"
            :aria-expanded="open">
      ALT
    </button>
    <div class="ap-media__alt-text" x-show="open" x-cloak>
      {{ photoAlt }}
    </div>
  {% endif %}
</div>
```

### Task 4.2: Style ALT badges

**File:** `assets/reader.css`

```css
.ap-media__alt-badge {
  position: absolute;
  bottom: 0.5rem;
  left: 0.5rem;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.15rem 0.35rem;
  border-radius: var(--border-radius-small);
  border: none;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.ap-media__alt-text {
  position: absolute;
  bottom: 2.5rem;
  left: 0.5rem;
  right: 0.5rem;
  background: rgba(0, 0, 0, 0.85);
  color: white;
  font-size: var(--font-size-s);
  padding: 0.5rem;
  border-radius: var(--border-radius-small);
  max-height: 8rem;
  overflow-y: auto;
}
```

### Task 4.3: Ensure media item containers are positioned

**File:** `assets/reader.css`

Each `.ap-media__item` must be `position: relative` for the absolute-positioned badge.

---

## Release 5: Interaction Counts (v2.5.4)

**Impact:** Medium — Shows social proof (3 likes, 12 boosts). Data is already available from Mastodon API; needs extraction from ActivityPub.

### Task 5.1: Store interaction counts from ActivityPub

**File:** `lib/timeline-store.js`

Fedify's `Note`/`Article` objects expose:
- `likes` — a `Collection` with `totalItems`
- `shares` — a `Collection` with `totalItems`
- `replies` — a `Collection` with `totalItems`

Extract in `extractObjectData()`:
```js
const counts = {
  replies: null,
  boosts: null,
  likes: null,
};
try {
  const replies = await object.getReplies?.({ documentLoader });
  counts.replies = replies?.totalItems ?? null;
} catch { /* ignore */ }
// Same for likes (object.getLikes) and shares (object.getShares)
```

Add `counts` to the returned object.

### Task 5.2: Store interaction counts from Mastodon API

**File:** `lib/controllers/explore-utils.js`

Direct mapping — Mastodon API provides:
```js
counts: {
  replies: status.replies_count || 0,
  boosts: status.reblogs_count || 0,
  likes: status.favourites_count || 0,
}
```

### Task 5.3: Display counts in interaction buttons

**File:** `views/partials/ap-item-card.njk`

Add count display next to each interaction button:
```njk
<button class="ap-interactions__btn ap-interactions__btn--like" ...>
  <svg>...</svg>
  {% if item.counts and item.counts.likes %}
    <span class="ap-interactions__count">{{ item.counts.likes }}</span>
  {% endif %}
</button>
```

### Task 5.4: Style interaction counts

**File:** `assets/reader.css`

```css
.ap-interactions__count {
  font-size: var(--font-size-xs);
  color: var(--color-on-offset);
  margin-left: 0.25rem;
}
```

### Task 5.5: Update counts on interaction (optimistic UI)

**File:** `assets/reader-infinite-scroll.js` or `ap-item-card.njk` Alpine component

When a user likes/boosts, increment the displayed count optimistically. Revert on error.

---

## Release 6: Skeleton Loaders (v2.5.5)

**Impact:** Medium — Replaces "Loading..." text with card-shaped animated placeholders. Pure CSS, no data changes.

### Task 6.1: Create skeleton card partial

**File:** `views/partials/ap-skeleton-card.njk` (new)

```njk
<div class="ap-card ap-card--skeleton" aria-hidden="true">
  <div class="ap-card__header">
    <div class="ap-skeleton ap-skeleton--avatar"></div>
    <div class="ap-skeleton-lines">
      <div class="ap-skeleton ap-skeleton--name"></div>
      <div class="ap-skeleton ap-skeleton--handle"></div>
    </div>
  </div>
  <div class="ap-card__body">
    <div class="ap-skeleton ap-skeleton--line"></div>
    <div class="ap-skeleton ap-skeleton--line ap-skeleton--line-short"></div>
  </div>
</div>
```

### Task 6.2: Add skeleton CSS

**File:** `assets/reader.css`

```css
.ap-skeleton {
  background: linear-gradient(90deg,
    var(--color-offset) 25%,
    var(--color-background) 50%,
    var(--color-offset) 75%);
  background-size: 200% 100%;
  animation: ap-skeleton-shimmer 1.5s infinite;
  border-radius: var(--border-radius-small);
}

@keyframes ap-skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

### Task 6.3: Replace "Loading..." with skeleton cards

**Files:** `views/activitypub-reader.njk`, `views/activitypub-explore.njk`

Where the load-more mechanism currently shows "Loading..." text, show 3 skeleton cards instead.

---

## Release 7: Content Enhancements (v2.6.0)

**Impact:** Medium — Polish features that improve content readability.

### Task 7.1: Long URL shortening in content

**File:** `lib/timeline-store.js` or new `lib/content-utils.js`

After sanitization, shorten displayed URLs longer than 30 characters in `<a>` tags:
```
https://very-long-domain.example.com/path/to/page → very-long-domain.example.com/pa…
```

Keep the full URL in `href`, only truncate the visible text node. Use a regex or DOM-like approach on the sanitized HTML.

### Task 7.2: Hashtag stuffing collapse

**File:** `lib/content-utils.js` (new utility)

Detect paragraphs that are 80%+ hashtag links (3+ tags). Wrap them in a collapsible container:
```html
<details class="ap-hashtag-overflow">
  <summary>Show tags</summary>
  <p>#tag1 #tag2 #tag3 #tag4 #tag5</p>
</details>
```

### Task 7.3: Bot account indicator

**Files:** `lib/timeline-store.js`, `lib/controllers/explore-utils.js`, `views/partials/ap-item-card.njk`

- Extract `bot` flag from actor data (Fedify: actor type === "Service"; Mastodon API: `account.bot`)
- Store as `author.bot: true/false`
- Display a small bot icon next to the display name in the card header

### Task 7.4: Edit indicator

**Files:** `lib/timeline-store.js`, `lib/controllers/explore-utils.js`, `views/partials/ap-item-card.njk`

- Extract `editedAt` / `updated` from post data
- Display a pencil icon or "(edited)" text next to the timestamp when `editedAt` exists and differs from `published`

---

## Release 8: Visual Polish (v2.6.1)

**Impact:** Low-medium — Focus-point cropping and blurhash placeholders for images.

### Task 8.1: Focus-point cropping

**File:** `views/partials/ap-item-media.njk`, `assets/reader.css`

Use the `focus.x` / `focus.y` data (range -1 to 1) to compute `object-position`:
```css
/* Convert from -1..1 to 0..100% */
object-position: calc(50% + focus.x * 50%) calc(50% - focus.y * 50%);
```

Apply as inline style on `<img>` elements when focus data is available.

### Task 8.2: Blurhash placeholders

**File:** `assets/reader-blurhash.js` (new), `views/partials/ap-item-media.njk`

- Store blurhash string in photo objects (done in Release 3)
- On client side, decode blurhash to a tiny canvas and use as background-image
- Uses the [blurhash](https://github.com/woltapp/blurhash) JS decoder (~1KB)
- Falls back gracefully — just shows the loading background color if blurhash unavailable

---

## Summary: Release Roadmap

| Release | Version | Key Feature | Prereqs | Scope |
|---------|---------|-------------|---------|-------|
| **0** | **v2.5.0-rc.1** | **Unify reader/explore pipeline** | **None** | **11 tasks** |
| 1 | v2.5.0 | Custom emoji rendering | Release 0 | 8 tasks |
| 2 | v2.5.1 | Relative timestamps | Release 0 | 4 tasks |
| 3 | v2.5.2 | Enriched media data model | Release 0 | 5 tasks |
| 4 | v2.5.3 | ALT text badges | Release 3 | 3 tasks |
| 5 | v2.5.4 | Interaction counts | Release 0 | 5 tasks |
| 6 | v2.5.5 | Skeleton loaders | Release 0 | 3 tasks |
| 7 | v2.6.0 | Content enhancements (URLs, hashtags, bot, edit) | Release 1 | 4 tasks |
| 8 | v2.6.1 | Visual polish (focus crop, blurhash) | Release 3 | 2 tasks |

**Release 0 is mandatory first** — all other releases depend on the unified pipeline.

After Release 0, releases 1-6 are independent of each other. 4 depends on 3, 7 depends on 1, 8 depends on 3.

**Recommended order:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

**Total: 45 tasks across 9 releases.**

---

## Files Modified Per Release

| File | R0 | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 |
|------|----|----|----|----|----|----|----|----|-----|
| `lib/item-processing.js` | **new** | x | | | | x | | x | |
| `lib/timeline-store.js` | | x | | x | | x | | x | |
| `lib/controllers/explore-utils.js` | | x | | x | | x | | x | |
| `lib/controllers/reader.js` | x | | | | | | | | |
| `lib/controllers/api-timeline.js` | x | | | | | | | | |
| `lib/controllers/explore.js` | x | | | | | | | | |
| `lib/controllers/post-detail.js` | | x | | | | | | | |
| `lib/emoji-utils.js` | | **new** | | | | | | | |
| `lib/content-utils.js` | | | | | | | | **new** | |
| `lib/storage/timeline.js` | | x | | x | | | | | |
| `lib/og-unfurl.js` | | | | x | | | | | |
| `assets/reader-infinite-scroll.js` | x | | | | | | | | |
| `assets/reader.css` | | x | | | x | x | x | | x |
| `assets/reader-relative-time.js` | | | **new** | | | | | | |
| `assets/reader-blurhash.js` | | | | | | | | | **new** |
| `views/partials/ap-item-card.njk` | | x | x | | | x | | x | |
| `views/partials/ap-item-media.njk` | | | | x | x | | | | x |
| `views/partials/ap-skeleton-card.njk` | | | | | | | **new** | | |
| `views/partials/ap-quote-embed.njk` | | | x | | | | | | |
| `views/activitypub-reader.njk` | x | | | | | | x | | |
| `views/activitypub-explore.njk` | x | | | | | | x | | |
| `views/layouts/ap-reader.njk` | | | x | | | | | | x |
| `views/activitypub-notifications.njk` | | | x | | | | | | |
| `views/activitypub-activities.njk` | | | x | | | | | | |

---

## Not Planned (Rationale)

| Feature | Why Not |
|---------|---------|
| Virtual scrolling | Server-rendered HTML is already lightweight; DOM nodes are cheap vs React/Vue vDOM |
| WebSocket streaming | Would require a persistent WS server; polling at 30s is adequate |
| Profile hover cards | Significant JS investment for marginal UX gain; clicking through to profile works fine |
| Mention hover cards | Same as above — high effort, low return for server-rendered approach |
| Keyboard shortcuts | Low demand; screen reader users already have nav shortcuts |
| Video autoplay on scroll | Most users prefer manual control; respects data/battery |
| Separate CW toggles (text vs media) | Current combined toggle works; splitting adds UI complexity |
