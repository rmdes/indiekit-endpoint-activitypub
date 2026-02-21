# ActivityPub Reader Implementation Plan

Created: 2026-02-21
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No

> **Status Lifecycle:** PENDING → COMPLETE → VERIFIED
> **Iterations:** Tracks implement→verify cycles (incremented by verify phase)
>
> - PENDING: Initial state, awaiting implementation
> - COMPLETE: All tasks implemented
> - VERIFIED: All checks passed
>
> **Approval Gate:** Implementation CANNOT proceed until `Approved: Yes`
> **Worktree:** Set at plan creation (from dispatcher). `Yes` uses git worktree isolation; `No` works directly on current branch

## Summary

**Goal:** Build a dedicated ActivityPub reader within the `@rmdes/indiekit-endpoint-activitypub` plugin, providing a timeline view of followed accounts' posts, a notifications stream, native AP interactions (like, boost, reply, follow/unfollow), and Micropub-based content creation — then remove the Microsub bridge dependency.

**Architecture:** The reader adds new MongoDB collections (`ap_timeline`, `ap_notifications`, `ap_muted`, `ap_blocked`) alongside new controllers, views, and a CSS stylesheet. Inbox listeners are refactored to store items natively instead of bridging to Microsub. Alpine.js provides client-side reactivity for interactions. Content creation uses two paths: direct Fedify `ctx.sendActivity()` for quick likes/boosts, and Micropub POST for replies that become blog posts (user chooses per-reply).

**Tech Stack:** Node.js/Express, MongoDB, Nunjucks templates, Alpine.js, Fedify SDK (`ctx.sendActivity()`, `ctx.lookupObject()`), Indiekit frontend components, CSS custom properties.

## Scope

### In Scope

- Timeline view showing posts from followed accounts with threading, content warnings, boosts, and rich media (images, video, audio, polls)
- Tab-based filtering (All, Notes, Articles, Replies, Boosts, Media)
- Notifications stream (likes, boosts, follows, mentions, replies received)
- Native AP interactions: like, boost, reply (with choice of direct AP or Micropub), follow/unfollow
- Mute/unmute (accounts and keywords), block/unblock
- Profile view for remote actors (view posts, follow/unfollow, mute, block)
- Compose form that submits via Micropub endpoint (for blog-worthy replies)
- Custom CSS stylesheet with card-based layout inspired by Phanpy/Elk
- Content warning spoiler toggle (Alpine.js)
- Image gallery grid for multi-image posts
- Video/audio embed rendering
- Removal of Microsub bridge (`storeTimelineItem`, `getApChannelId`, lazy `microsub_items`/`microsub_channels` accessors)

### Out of Scope

- Mastodon REST API compatibility (no mobile client support — would be a separate project)
- Lists (organizing follows into named groups) — deferred to future plan
- Local/Federated timeline distinction (single timeline of followed accounts only)
- Full-text search within timeline items
- Polls (rendering existing polls is in scope; creating polls is not)
- Direct messages / conversations
- Push notifications (browser notifications)
- Infinite scroll (standard pagination is used)
- Video/audio upload in compose form

## Prerequisites

- Plugin is at v1.0.29+ with all federation hardening features complete
- Fedify SDK available via `this._federation` on the plugin instance
- MongoDB collections infrastructure in `index.js`
- Indiekit frontend components available (`@indiekit/frontend`)
- Alpine.js: **NOT loaded by Indiekit core**. The reader layout must explicitly load Alpine.js via a `<script>` CDN tag (e.g., `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>`). The existing AP dashboard views use `x-data` directives — they work because the Cloudron deployment's CSP allows `cdn.jsdelivr.net` (see `nginx.conf`). The reader layout template must include Alpine.js in its `<head>` block.
- `sanitize-html` package (add to `package.json` dependencies — used by Microsub plugin already, needed here for XSS prevention on remote content)

## Context for Implementer

> This section is critical for cross-session continuity. Write it for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Route registration: See `index.js:143-169` — admin routes go in `get routes()` method, registered at `/admin/activitypub/*`
  - Controller pattern: Each controller exports async functions taking `(request, response)`. See `lib/controllers/dashboard.js` as example
  - View pattern: Views are `activitypub-*.njk` files in `views/`. They extend `document.njk` and use Indiekit frontend component macros (`card`, `button`, `badge`, `pagination`, etc.)
  - Collection registration: See `index.js:614-621` — register via `Indiekit.addCollection("name")` calls in `init()`, then store references via `this._collections.name = indiekitCollections.get("name")`
  - i18n: All user-visible strings go in `locales/en.json` under the `activitypub` namespace, referenced via `__("activitypub.reader.xxx")`
  - Asset serving: Place CSS/JS in `assets/` directory. Indiekit core serves at `/assets/@rmdes-indiekit-endpoint-activitypub/`. Reference from views with `<link>` tag.

- **Conventions:**
  - ESM modules throughout (`import`/`export`)
  - ISO 8601 strings for dates in MongoDB (except `published` in timeline items which uses `Date` for sorting queries)
  - Nunjucks templates use `{% from "xxx.njk" import component %}` for Indiekit frontend components
  - Alpine.js `x-data`, `x-show`, `x-on:click` for client-side interactivity (loaded explicitly in reader layout, NOT by Indiekit core)
  - CSRF protection: Indiekit core has no CSRF middleware. POST endpoints that trigger ActivityPub activities must validate a CSRF token. Use a simple pattern: generate a token per-session and embed as a hidden field in forms / include in `fetch()` headers. Validate on the server side before processing.

- **Key files:**
  - `index.js` — Plugin entry point, routes, collections, syndicator, follow/unfollow methods
  - `lib/inbox-listeners.js` — All inbox activity handlers (Follow, Like, Announce, Create, Delete, etc.)
  - `lib/federation-setup.js` — Fedify federation object configuration (dispatchers, queue, etc.)
  - `locales/en.json` — English translations
  - `views/activitypub-dashboard.njk` — Dashboard view (reference for card-grid patterns)
  - `views/activitypub-following.njk` — Following view (reference for list+pagination)

- **Gotchas:**
  - Fedify returns `Temporal.Instant` for dates, not JS `Date`. Convert with `new Date(Number(obj.published.epochMilliseconds))`
  - Fedify object properties are often async getters — `await actorObj.icon` not `actorObj.icon`
  - `ctx.sendActivity()` first argument is `{ identifier: handle }` where `handle` comes from plugin options
  - The plugin stores `this._federation` and creates context via `this._federation.createContext(new URL(this._publicationUrl), { handle, publicationUrl })`
  - Remote actor lookup uses `ctx.lookupObject("@handle@instance")` or `ctx.lookupObject("https://url")`
  - The AP plugin's asset directory is `assets/` at the package root, served at `/assets/@rmdes-indiekit-endpoint-activitypub/`

- **Domain context:**
  - ActivityPub activities: `Like` (favorite), `Announce` (boost/repost), `Create` (new post), `Follow`/`Undo(Follow)`, `Accept`, `Reject`, `Delete`, `Update`, `Block`, `Move`
  - Content warnings use the `summary` field on AP objects (Mastodon convention)
  - Boosts are `Announce` activities wrapping the original post — the reader must render the original post with boost attribution
  - Replies use `inReplyTo` linking to the parent post URL
  - Sensitive content uses the `sensitive` boolean on AP objects

## Runtime Environment

- **Start command:** `cloudron exec --app rmendes.net` or locally `npm start` in the Cloudron container
- **Port:** Indiekit on 8080 (behind nginx on 3000)
- **Health check:** `curl https://rmendes.net/.well-known/webfinger?resource=acct:rick@rmendes.net`
- **Deploy:** Build via `cloudron build --no-cache && cloudron update --app rmendes.net --no-backup`

## Feature Inventory — Microsub Bridge Being Replaced

### Files Being Modified (Bridge Removal)

| Old Code | Functions | Mapped to Task |
|----------|-----------|----------------|
| `lib/inbox-listeners.js` — function `storeTimelineItem()` (~line 468) | Timeline item storage from AP activities | Task 2 (store natively), Task 12 (remove bridge) |
| `lib/inbox-listeners.js` — function `getApChannelId()` (~line 413) | Auto-creates Microsub "Fediverse" channel | Task 12 (remove) |
| `index.js` — lazy accessors in `init()` (~line 638) | `microsub_items`, `microsub_channels` collection refs | Task 12 (remove) |
| `lib/inbox-listeners.js` — Create handler (~line 262, calls `storeTimelineItem` at ~line 310) | Stores incoming posts via bridge | Task 2 (redirect to native storage) |

### Feature Mapping Verification

- [x] `storeTimelineItem()` → Task 2 (native `ap_timeline` storage)
- [x] `getApChannelId()` → Task 12 (removed; no longer needed)
- [x] Lazy Microsub collection accessors → Task 12 (removed)
- [x] Inbox Create handler → Task 2 (rewired to native storage)
- [x] Like/Announce inbox storage → Task 3 (notification storage)

## Progress Tracking

**MANDATORY: Update this checklist as tasks complete. Change `[ ]` to `[x]`.**

- [x] Task 1: MongoDB collections and data models
- [x] Task 2: Inbox listener refactor — native timeline storage (includes Delete/Update handling)
- [x] Task 3: Inbox listener refactor — notification storage
- [x] Task 4: Timeline controller and view
- [x] Task 5: Reader CSS stylesheet
- [x] Task 6: Notifications controller and view
- [x] Task 7a: Interaction API — Like and Boost endpoints (with CSRF)
- [x] Task 7b: Interaction UI — Like and Boost buttons (Alpine.js)
- [x] Task 8: Compose form — Micropub reply path
- [x] Task 9: Content warning toggles and rich media rendering
- [x] Task 10: Mute, block, and tab filtering
- [x] Task 11: Remote profile view
- [x] Task 12: Remove Microsub bridge
- [x] Task 13: Timeline retention cleanup

**Total Tasks:** 14 | **Completed:** 14 | **Remaining:** 0

## Implementation Tasks

### Task 1: MongoDB Collections and Data Models

**Objective:** Register new MongoDB collections (`ap_timeline`, `ap_notifications`, `ap_muted`, `ap_blocked`, `ap_interactions`) and create indexes for efficient querying.

**Dependencies:** None

**Files:**

- Modify: `index.js` — Register collections via `Indiekit.addCollection()` in `init()`, store references in `this._collections`, create indexes
- Create: `lib/storage/timeline.js` — Timeline CRUD functions
- Create: `lib/storage/notifications.js` — Notification CRUD functions
- Create: `lib/storage/moderation.js` — Mute/block CRUD functions

**Key Decisions / Notes:**

- `ap_timeline` schema:
  ```js
  {
    uid: "https://remote.example/posts/123",  // canonical AP object URL (dedup key)
    type: "note" | "article" | "boost",       // boost = Announce wrapper
    url: "https://remote.example/posts/123",
    name: "Post Title" | null,                // Articles only
    content: { text: "...", html: "..." },
    summary: "Content warning text" | null,    // CW / spoiler
    sensitive: false,                          // Mastodon sensitive flag
    published: Date,                           // Date object for sort queries
    author: { name, url, photo, handle },      // handle = "@user@instance"
    category: ["tag1", "tag2"],
    photo: ["url1", "url2"],
    video: ["url1"],
    audio: ["url1"],
    inReplyTo: "https://parent-post-url" | null,
    boostedBy: { name, url, photo, handle } | null,  // For Announce activities
    boostedAt: Date | null,                           // When the boost happened
    originalUrl: "https://original-post-url" | null,  // For boosts: the wrapped object URL
    readBy: [],
    createdAt: "ISO string"
  }
  ```
- `ap_notifications` schema:
  ```js
  {
    uid: "activity-id",           // dedup key
    type: "like" | "boost" | "follow" | "mention" | "reply",
    actorUrl: "https://remote.example/@user",
    actorName: "Display Name",
    actorPhoto: "https://...",
    actorHandle: "@user@instance",
    targetUrl: "https://my-post-url" | null,  // The post they liked/boosted/replied to
    targetName: "My Post Title" | null,
    content: { text: "...", html: "..." } | null,  // For mentions/replies
    published: Date,
    read: false,
    createdAt: "ISO string"
  }
  ```
- `ap_muted`: `{ url: "actor-url", keyword: null, mutedAt: "ISO" }` — url OR keyword, not both
- `ap_blocked`: `{ url: "actor-url", blockedAt: "ISO" }`
- `ap_interactions`: `{ type: "like"|"boost", objectUrl: "https://...", activityId: "urn:uuid:...", createdAt: "ISO" }` — tracks outgoing interactions for undo support and UI state
- Indexes:
  - `ap_timeline`: `{ uid: 1 }` unique, `{ published: -1 }` for timeline sort, `{ "author.url": 1 }` for profile view, `{ type: 1, published: -1 }` for tab filtering
  - `ap_notifications`: `{ uid: 1 }` unique, `{ published: -1 }` for sort, `{ read: 1 }` for unread count
  - `ap_muted`: `{ url: 1 }` unique (sparse), `{ keyword: 1 }` unique (sparse)
  - `ap_blocked`: `{ url: 1 }` unique
  - `ap_interactions`: `{ objectUrl: 1, type: 1 }` compound unique (one like/boost per object), `{ type: 1 }` for listing
- Storage functions follow the pattern in Microsub's `lib/storage/items.js` — export pure functions that take `(collections, ...)` parameters
- `addTimelineItem(collections, item)` uses atomic upsert: `updateOne({ uid }, { $setOnInsert: item }, { upsert: true })`
- `getTimelineItems(collections, { before, after, limit, type, authorUrl })` returns cursor-paginated results
- `addNotification(collections, notification)` uses atomic upsert
- `getNotifications(collections, { before, limit })` returns paginated, newest-first
- `getUnreadNotificationCount(collections)` returns count of `{ read: false }`

**Definition of Done:**

- [ ] All five collections registered via `Indiekit.addCollection()` in `init()` (ap_timeline, ap_notifications, ap_muted, ap_blocked, ap_interactions)
- [ ] Indexes created in `init()` method
- [ ] `addTimelineItem` stores item and deduplicates by uid
- [ ] `getTimelineItems` returns paginated results with before/after cursors
- [ ] `addNotification` stores notification and deduplicates
- [ ] `getNotifications` returns paginated newest-first
- [ ] `getUnreadNotificationCount` returns correct count
- [ ] Mute/block CRUD operations work (add, remove, list, check)
- [ ] All storage functions have unit tests

**Verify:**

- `cd /home/rick/code/indiekit-dev/indiekit-endpoint-activitypub && node -e "import('./lib/storage/timeline.js').then(m => console.log(Object.keys(m)))"` — exports exist
- `cd /home/rick/code/indiekit-dev/indiekit-endpoint-activitypub && node -e "import('./lib/storage/notifications.js').then(m => console.log(Object.keys(m)))"` — exports exist
- `cd /home/rick/code/indiekit-dev/indiekit-endpoint-activitypub && node -e "import('./lib/storage/moderation.js').then(m => console.log(Object.keys(m)))"` — exports exist

---

### Task 2: Inbox Listener Refactor — Native Timeline Storage

**Objective:** Modify the inbox Create handler to store posts in `ap_timeline` instead of bridging to Microsub. Also handle Announce (boost) activities by storing the wrapped object with boost attribution.

**Dependencies:** Task 1

**Files:**

- Modify: `lib/inbox-listeners.js` — Refactor Create handler (~line 262) and Announce handler (~line 233) to store in `ap_timeline`, plus Delete/Update handlers for timeline cleanup
- Modify: `package.json` — Add `sanitize-html` to dependencies
- Create: `lib/timeline-store.js` — Helper that extracts data from Fedify objects and calls storage functions

**Key Decisions / Notes:**

- The existing Create handler at `inbox-listeners.js` (function `registerInboxListeners`, Create section ~line 262) currently calls `storeTimelineItem()`. Replace that call with the new native storage
- **CRITICAL — Announce handler bifurcation required:** The current Announce handler (line ~237) has an early return that ONLY processes boosts of our own content: `if (!objectId || (pubUrl && !objectId.startsWith(pubUrl))) return;`. This filter MUST be modified to create two code paths:
  1. **Boost of our content** (objectId starts with pubUrl) → store as notification (Task 3)
  2. **Boost from a followed account** (announcing actor is in our followers/following) → store in `ap_timeline` with `type: "boost"`
  3. **Both conditions true** (a followed account boosts our post) → store BOTH notification AND timeline item
- For timeline boosts: fetch the wrapped object via `await announce.getObject()` (the current handler only reads `announce.objectId` URL, NOT the full object), extract its data, then store with `type: "boost"` and `boostedBy` populated from the announcing actor
- To check if the announcing actor is followed: query `ap_followers` or `ap_following` collection for the actor URL
- Keep the same Fedify object→data extraction logic from `storeTimelineItem` (content, photos, videos, tags, etc.) but move it to a reusable `extractObjectData(object, actorObj)` function in `lib/timeline-store.js`
- **CRITICAL: HTML sanitization** — Remote content HTML MUST be sanitized before storage using `sanitize-html` (same library used in Microsub's `lib/webmention/verifier.js`). Allow safe tags: `a`, `p`, `br`, `em`, `strong`, `blockquote`, `ul`, `ol`, `li`, `code`, `pre`, `span`, `h1`-`h6`, `img`. Allow `href` on `a`, `src`/`alt` on `img`, `class` on `span` (for Mastodon custom emoji). Strip all other HTML including `<script>`, `<style>`, event handlers. This prevents XSS when rendering content with Nunjucks `| safe` filter
- Check muted/blocked before storing — skip items from muted URLs or containing muted keywords
- The existing `storeTimelineItem()` and `getApChannelId()` functions remain for now (cleaned up in Task 12)
- For replies (`inReplyTo`), store the parent URL so the frontend can render threading context
- **Delete activity handling:** Modify the existing Delete handler (`inbox-listeners.js` ~line 318) to also remove items from `ap_timeline` (currently only deletes from `ap_activities`). When a remote user deletes a post, remove the corresponding `ap_timeline` entry by uid.
- **Update activity handling:** Modify the existing Update handler (`inbox-listeners.js` ~line 345) to also update `ap_timeline` items. Currently it only refreshes follower/actor profile data. When a remote user edits a post (Update activity), re-extract the content and update the timeline item. This prevents showing stale content for edited posts.

**Definition of Done:**

- [ ] Create activities from followed accounts stored in `ap_timeline` with all fields populated
- [ ] Announce (boost) activities stored with `type: "boost"`, `boostedBy`, and the original post content
- [ ] Muted actors' posts are skipped during storage
- [ ] Blocked actors' posts are skipped during storage
- [ ] Posts containing muted keywords are skipped
- [ ] Duplicate posts (same uid) are not created
- [ ] Remote HTML content sanitized before storage (no `<script>`, `<style>`, event handlers)
- [ ] Delete activities remove corresponding items from `ap_timeline`
- [ ] Update activities refresh content of existing `ap_timeline` items
- [ ] Tests verify Create → timeline storage flow
- [ ] Tests verify Announce → timeline storage with boost attribution
- [ ] Tests verify Delete → timeline item removal
- [ ] Tests verify Update → timeline item content refresh

**Verify:**

- Integration test: Send a mock Create activity, verify it appears in `ap_timeline` collection
- Integration test: Send a mock Announce activity, verify boost attribution stored correctly

---

### Task 3: Inbox Listener Refactor — Notification Storage

**Objective:** Store incoming Like, Announce (of our posts), Follow, and mention/reply activities as notifications in `ap_notifications`.

**Dependencies:** Task 1

**Files:**

- Modify: `lib/inbox-listeners.js` — Add notification storage calls in Like handler (`activity instanceof Like`), Announce handler (`activity instanceof Announce`), Follow handler (`activity instanceof Follow`), Create handler for mentions/replies

**Key Decisions / Notes:**

- **Like handler** (in `registerInboxListeners`, search for `activity instanceof Like`): already logs to `ap_activities` and filters to only likes of our own posts. This filter is correct for notifications. Add a call to `addNotification()` with `type: "like"`, including the actor info and the liked post URL
- **Announce handler** (search for `activity instanceof Announce`): the dual-path logic from Task 2 handles timeline storage. For notifications, when someone boosts OUR post (objectId starts with pubUrl), store as notification `type: "boost"`
- Follow handler: store as notification `type: "follow"` when someone new follows us
- Create handler: if the post is a reply TO one of our posts (check `inReplyTo` against our publication URL), store as `type: "reply"`; if it mentions us (check tags for Mention with our actor URL), store as `type: "mention"`
- Notification dedup by activity ID or constructed uid (e.g., `like:${actorUrl}:${objectUrl}`)
- Extract actor info (name, photo, handle) from Fedify actor object — use same `extractActorInfo()` helper

**Definition of Done:**

- [ ] Likes of our posts create notification with type "like"
- [ ] Boosts of our posts create notification with type "boost"
- [ ] New follows create notification with type "follow"
- [ ] Replies to our posts create notification with type "reply"
- [ ] Mentions of our actor create notification with type "mention"
- [ ] Notifications are deduplicated by uid
- [ ] All notification types include correct actor info and target post info
- [ ] Tests verify each notification type is stored correctly

**Verify:**

- Unit tests for notification storage from each activity type
- Verify on live site: receive a like → check `ap_notifications` collection via MongoDB query

---

### Task 4: Timeline Controller and View

**Objective:** Create the reader timeline page at `/admin/activitypub/reader` showing posts from followed accounts with pagination, and a reader navigation sidebar.

**Dependencies:** Task 1, Task 2

**Files:**

- Create: `lib/controllers/reader.js` — Timeline controller
- Create: `views/layouts/reader.njk` — Reader layout (extends `document.njk`, adds Alpine.js CDN `<script>` tag and reader stylesheet `<link>`)
- Create: `views/activitypub-reader.njk` — Timeline view (extends `layouts/reader.njk`)
- Create: `views/partials/ap-item-card.njk` — Timeline item card partial
- Modify: `index.js` — Add reader routes and navigation item
- Modify: `locales/en.json` — Add reader i18n strings

**Key Decisions / Notes:**

- Route: `GET /admin/activitypub/reader` → timeline (default tab: "All")
- Route: `GET /admin/activitypub/reader?tab=notes|articles|replies|boosts|media` → filtered tab
- Route: `GET /admin/activitypub/reader?before=cursor` → pagination
- Navigation: Add "Reader" as first navigation item (before Dashboard) with an unread notification count badge
- Timeline controller calls `getTimelineItems()` with optional `type` filter based on tab
- Item card renders: author (avatar + name + handle), content (HTML), photos (grid), video (embed), audio (player), categories/tags, published date, interaction buttons (like, boost, reply, profile link)
- Card layout inspired by Phanpy/Elk: clean white cards with subtle shadows, rounded corners, generous spacing
- Use cursor-based pagination (same pattern as Microsub: `before`/`after` query params)
- Mark items as read when the timeline page loads (or use a "mark all read" button)
- The partial `ap-item-card.njk` renders a single timeline item — reused in both timeline and profile views
- For boosts: show "🔁 {booster} boosted" header above the original post card
- For replies: show "↩ Replying to {parentAuthorUrl}" link above content
- **HTML rendering:** Use `{{ item.content.html | safe }}` in templates — this is safe because content was sanitized at storage time (Task 2). Do NOT use `| safe` on any unsanitized user input
- **Navigation architecture:** Indiekit's `get navigationItems()` returns flat top-level items in the sidebar. The AP plugin currently returns one item ("ActivityPub" → `/activitypub`). Change this to return "Reader" as the primary navigation item (→ `/activitypub/reader`), and add sub-navigation within the reader views (Dashboard, Reader, Notifications, Following, Settings/Moderation) using a local `<nav>` in the view template — NOT via `get navigationItems()` (which only handles top-level sidebar items)

**Definition of Done:**

- [ ] `/admin/activitypub/reader` renders timeline with posts from followed accounts
- [ ] Item cards show author info, content, media, tags, date, and interaction buttons
- [ ] Tab filtering works for notes, articles, replies, boosts, media
- [ ] Pagination works with cursor-based before/after
- [ ] Boost attribution renders correctly (boosted by header)
- [ ] Reply context renders (replying to link)
- [ ] Navigation item appears in sidebar with Reader label
- [ ] Empty state shown when timeline is empty

**Verify:**

- `curl -s https://rmendes.net/admin/activitypub/reader -H "Cookie: ..." | grep -c "ap-item-card"` — returns item count
- Visual check via `playwright-cli open https://rmendes.net/admin/activitypub/reader`

---

### Task 5: Reader CSS Stylesheet

**Objective:** Create a custom CSS stylesheet for the AP reader with card-based layout, image grids, and responsive design.

**Dependencies:** Task 4

**Files:**

- Create: `assets/reader.css` — Reader stylesheet
- Modify: `views/activitypub-reader.njk` — Link stylesheet

**Key Decisions / Notes:**

- Follow the pattern from Microsub: `<link rel="stylesheet" href="/assets/@rmdes-indiekit-endpoint-activitypub/reader.css">`
- Use Indiekit CSS custom properties: `--space-s`, `--space-m`, `--space-l`, `--color-offset`, `--border-radius`, `--color-text`, `--color-background`, etc.
- Card styles: `.ap-card` — white background, border, rounded corners, padding, margin-bottom
- Author header: `.ap-card__author` — flexbox row with avatar (40px circle), name (bold), handle (@user@instance, muted), timestamp (right-aligned, relative)
- Content: `.ap-card__content` — prose-like styling, max-width for readability
- Image grid: `.ap-card__gallery` — CSS Grid, 2-column for 2 images, 2x2 for 3-4 images, rounded corners, gap
- Video embed: `.ap-card__video` — responsive 16:9 container
- Audio player: `.ap-card__audio` — full-width native audio element
- Content warning: `.ap-card__cw` — blurred/collapsed content behind a "Show more" button
- Boost header: `.ap-card__boost` — small text with repost icon, muted color
- Reply context: `.ap-card__reply-to` — small text with reply icon, linked to parent
- Interaction buttons: `.ap-card__actions` — flexbox row, icon buttons with count labels
- Tab bar: `.ap-tabs` — horizontal tabs, active tab highlighted
- Notifications: `.ap-notification` — compact card with icon, actor, action description, post excerpt
- Responsive: Stack to single column on mobile, full-width cards
- Dark mode: Use Indiekit's `prefers-color-scheme` media query with its CSS custom properties

**Definition of Done:**

- [ ] Cards render with clean, readable layout
- [ ] Image gallery works for 1-4 images with proper grid
- [ ] Content warnings show blurred/collapsed state
- [ ] Interaction buttons aligned horizontally below content
- [ ] Tab bar renders with active state
- [ ] Responsive on mobile viewport
- [ ] Uses Indiekit CSS custom properties (not hardcoded colors)

**Verify:**

- `playwright-cli open https://rmendes.net/admin/activitypub/reader` → screenshot → visual check
- `playwright-cli resize 375 812` → mobile check

---

### Task 6: Notifications Controller and View

**Objective:** Create the notifications page at `/admin/activitypub/reader/notifications` showing likes, boosts, follows, mentions, and replies received.

**Dependencies:** Task 3, Task 5

**Files:**

- Modify: `lib/controllers/reader.js` — Add notifications controller function
- Create: `views/activitypub-notifications.njk` — Notifications view (extends `layouts/reader.njk`)
- Create: `views/partials/ap-notification-card.njk` — Notification card partial
- Modify: `index.js` — Add notification route
- Modify: `locales/en.json` — Add notification i18n strings

**Key Decisions / Notes:**

- Route: `GET /admin/activitypub/reader/notifications`
- Notification card is more compact than timeline card: icon + actor name + action text + post excerpt + timestamp
- Group similar notifications? No — keep it chronological for simplicity
- Mark notifications as read when the page loads (set `read: true` on all displayed)
- Unread count shown as badge on "Reader" navigation item (combine timeline and notification counts)
- Notification type → display:
  - `like`: "❤ {actor} liked your post {title}" with link to the post
  - `boost`: "🔁 {actor} boosted your post {title}"
  - `follow`: "👤 {actor} followed you" with link to their profile
  - `reply`: "💬 {actor} replied to your post {title}" with content preview
  - `mention`: "@ {actor} mentioned you" with content preview
- Pagination: same cursor-based pattern as timeline

**Definition of Done:**

- [ ] `/admin/activitypub/reader/notifications` renders notification stream
- [ ] Each notification type displays correctly with icon, actor, action, and target
- [ ] Notifications marked as read when page loads
- [ ] Unread count appears on Reader navigation badge
- [ ] Pagination works for notifications
- [ ] Empty state shown when no notifications

**Verify:**

- `curl -s https://rmendes.net/admin/activitypub/reader/notifications -H "Cookie: ..."` — renders HTML
- Check unread badge updates after viewing notifications

---

### Task 7a: Interaction API — Like and Boost Endpoints

**Objective:** Create the server-side API endpoints for Like, Unlike, Boost, and Unboost that send ActivityPub activities via Fedify.

**Dependencies:** Task 1, Task 4

**Files:**

- Create: `lib/controllers/interactions.js` — Handle like/boost/unlike/unboost POST requests (receives plugin instance via injection)
- Create: `lib/csrf.js` — Simple CSRF token generation and validation middleware
- Modify: `index.js` — Add interaction routes, inject plugin instance into controller (same pattern as `refollowPauseController(mp, this)` at `index.js:165-166`)
- Modify: `locales/en.json` — Add interaction i18n strings

**Key Decisions / Notes:**

- **CRITICAL — Federation context injection:** Regular controllers only have access to `request.app.locals.application` — they do NOT have `this._federation` or `this._collections`. The interaction controller needs federation context to call `ctx.sendActivity()`. Follow the refollow controller pattern: in `index.js`, pass the plugin instance when registering routes: `interactionController(mp, this)`. The controller factory returns route handlers with access to `pluginInstance._federation` and `pluginInstance._collections`. This same pattern is needed for ALL controllers that send ActivityPub activities (interactions, compose, moderation/block).
- **CSRF protection:** Generate a per-session CSRF token (store in `request.session.csrfToken`). Embed as hidden field in forms and as `X-CSRF-Token` header in `fetch()` requests. Validate on all POST endpoints before processing. Create `lib/csrf.js` with `generateToken(session)` and `validateToken(request)` functions.
- Routes:
  - `POST /admin/activitypub/reader/like` — body: `{ url: "post-url", _csrf: "token" }` → sends Like activity
  - `POST /admin/activitypub/reader/unlike` — body: `{ url: "post-url", _csrf: "token" }` → sends Undo(Like)
  - `POST /admin/activitypub/reader/boost` — body: `{ url: "post-url", _csrf: "token" }` → sends Announce activity
  - `POST /admin/activitypub/reader/unboost` — body: `{ url: "post-url", _csrf: "token" }` → sends Undo(Announce)
- Implementation pattern (like):
  1. Validate CSRF token
  2. Look up the post author via the post URL using `ctx.lookupObject(url)`
  3. Construct a `Like` activity with the post as object
  4. Send via `ctx.sendActivity({ identifier: handle }, recipient, likeActivity)`
  5. Store the interaction in `ap_interactions` collection
  6. Return JSON response `{ success: true, type: "like", objectUrl: "..." }`
- For Announce (boost): construct `Announce` activity wrapping the original post, send to followers via shared inbox
- Track interactions in `ap_interactions` collection `{ type: "like"|"boost", objectUrl: "...", activityId: "urn:uuid:...", createdAt: "ISO" }` — allows undo by looking up the activity ID
- Error handling: return JSON `{ success: false, error: "message" }` with appropriate HTTP status

**Definition of Done:**

- [ ] Like endpoint sends Like activity to remote actor's inbox
- [ ] Unlike endpoint sends Undo(Like) activity
- [ ] Boost endpoint sends Announce activity to followers
- [ ] Unboost endpoint sends Undo(Announce) activity
- [ ] CSRF token validated on all POST endpoints
- [ ] Interaction tracking persisted in `ap_interactions`
- [ ] JSON response returned for all endpoints
- [ ] Tests verify activity construction and sending

**Verify:**

- Like a post via `curl -X POST .../reader/like -d '{"url":"...","_csrf":"..."}'` → check JSON response
- Verify `ap_interactions` collection has the record
- Check remote instance shows the like (manual)

---

### Task 7b: Interaction UI — Like and Boost Buttons

**Objective:** Add Alpine.js-powered like/boost buttons to timeline cards with optimistic updates and error handling.

**Dependencies:** Task 7a

**Files:**

- Modify: `views/partials/ap-item-card.njk` — Add like/boost buttons with Alpine.js reactivity
- Modify: `lib/controllers/reader.js` — Query `ap_interactions` on timeline load to populate liked/boosted state, pass CSRF token to template
- Modify: `assets/reader.css` — Add interaction button styles (if not already in Task 5)

**Key Decisions / Notes:**

- Use Alpine.js `x-data` on each card to track `liked` and `boosted` state — initialized from server data
- Timeline controller queries `ap_interactions` for all displayed item URLs, builds a Set of liked/boosted URLs, passes to template
- Button click makes `fetch()` POST with CSRF token in `X-CSRF-Token` header, toggles visual state immediately (optimistic update)
- Error handling: if the API returns `{ success: false }`, revert the visual state and show a brief error message
- Button styling: heart icon for like (filled when liked), repost icon for boost (highlighted when boosted)

**Definition of Done:**

- [ ] Like/boost buttons appear on every timeline card
- [ ] Button state reflects server state on page load (already-liked/boosted show active)
- [ ] Clicking like sends POST and toggles button visually
- [ ] Clicking boost sends POST and toggles button visually
- [ ] Failed interactions revert button state and show error
- [ ] CSRF token included in all fetch() requests

**Verify:**

- `playwright-cli open .../reader` → find a post → click like → verify button state changes
- Reload page → verify liked state persists
- Unlike → verify button reverts

---

### Task 8: Compose Form — Micropub Reply Path

**Objective:** Add a compose form for replying to posts, with the option to submit via Micropub (creating a blog post) or via direct AP reply.

**Dependencies:** Task 4, Task 7a

**Files:**

- Modify: `lib/controllers/reader.js` — Add compose and submitCompose functions
- Create: `views/activitypub-compose.njk` — Compose form view
- Modify: `views/partials/ap-item-card.njk` — Add reply button linking to compose
- Modify: `index.js` — Add compose routes
- Modify: `locales/en.json` — Add compose i18n strings

**Key Decisions / Notes:**

- Routes:
  - `GET /admin/activitypub/reader/compose?replyTo=url` — Show compose form
  - `POST /admin/activitypub/reader/compose` — Submit reply
- Compose form has two submit paths (radio toggle):
  1. **"Post as blog reply" (Micropub)** — Submits to Micropub endpoint as `in-reply-to` + `content`, creating a permanent blog post that gets syndicated to AP via the existing syndicator pipeline
  2. **"Quick reply" (Direct AP)** — Constructs a Create(Note) activity with `inReplyTo` and sends directly via `ctx.sendActivity()` to the author's inbox + followers. No blog post created.
- The form pattern borrows from Microsub compose (`views/compose.njk`): textarea, hidden in-reply-to field, syndication target checkboxes (for Micropub path)
- For the quick reply path: the Note is ephemeral (not stored as a blog post) but IS stored in the timeline as the user's own post
- Fetch syndication targets from Micropub config endpoint (same pattern as Microsub compose at `reader.js:403-407`)
- **Micropub endpoint discovery:** Access via `request.app.locals.application.micropubEndpoint` (same as Microsub). Auth token from `request.session.access_token`. Build absolute URL from relative endpoint path using `application.url` as base.
- Character counter for quick reply mode (AP convention: 500 chars)
- Reply context: show the parent post above the compose form (fetch via stored timeline item or `ctx.lookupObject()`)
- **Federation context injection:** The compose controller needs plugin instance for the direct AP reply path (same `ctx.sendActivity()` pattern as Task 7a). Register via same injection pattern.
- **CSRF protection:** Both form submit paths must validate CSRF token (reuse `lib/csrf.js` from Task 7a)

**Definition of Done:**

- [ ] Compose form renders with reply context (parent post preview)
- [ ] "Post as blog reply" submits via Micropub and redirects back to reader
- [ ] "Quick reply" sends Create(Note) directly via Fedify
- [ ] Quick reply includes proper `inReplyTo` reference
- [ ] Quick reply is delivered to the original author's inbox
- [ ] Syndication targets appear for Micropub path
- [ ] Character counter works in quick reply mode
- [ ] Error handling for both paths

**Verify:**

- Post a Micropub reply → verify blog post created and syndicated
- Post a quick reply → verify it appears on the remote instance as a reply
- Check `in-reply-to` is correctly set in both cases

---

### Task 9: Content Warning Toggles and Rich Media Rendering

**Objective:** Implement content warning spoiler toggle (click to reveal), image gallery grid, and video/audio embeds in timeline cards.

**Dependencies:** Task 4, Task 5

**Files:**

- Modify: `views/partials/ap-item-card.njk` — Add CW toggle, gallery grid, video/audio
- Modify: `assets/reader.css` — Add styles for CW, gallery, video, audio

**Key Decisions / Notes:**

- **Content warnings:** Posts with `summary` field (Mastodon CW) render as:
  - Visible: CW text (the summary)
  - Hidden (behind button): The actual content + media
  - Alpine.js `x-data="{ revealed: false }"` + `x-show="revealed"` + `@click="revealed = !revealed"`
  - Button text toggles: "Show more" / "Show less"
  - `sensitive: true` without summary: "Sensitive content" as default CW text
- **Image gallery:**
  - 1 image: Full width, max-height with object-fit: cover
  - 2 images: Side-by-side (50/50 grid)
  - 3 images: First image full width, second and third side-by-side below
  - 4+ images: 2x2 grid, "+N more" overlay on 4th image if >4
  - All images rounded corners, gap between
  - Click to expand? Lightbox is out of scope — just link to full image
- **Video:** `<video>` tag with controls, poster if available, responsive wrapper
- **Audio:** `<audio>` tag with controls, full width
- **Polls:** Render poll options as a list with vote counts if available (read-only display)

**Definition of Done:**

- [ ] Content warnings display summary text with "Show more" button
- [ ] Clicking "Show more" reveals hidden content and media
- [ ] Clicking "Show less" re-hides content
- [ ] Image gallery renders correctly for 1, 2, 3, and 4+ images
- [ ] Videos render with native player controls
- [ ] Audio renders with native player controls
- [ ] Sensitive posts without summary show "Sensitive content" label

**Verify:**

- `playwright-cli open https://rmendes.net/admin/activitypub/reader`
- Find a post with CW → click "Show more" → content reveals
- Find a post with multiple images → verify grid layout
- `playwright-cli snapshot` → verify structure

---

### Task 10: Mute, Block, and Tab Filtering

**Objective:** Add mute/block functionality for actors and keywords, and implement tab-based timeline filtering.

**Dependencies:** Task 1, Task 4

**Files:**

- Create: `lib/controllers/moderation.js` — Mute/block controller
- Modify: `lib/controllers/reader.js` — Add tab filtering logic, mute/block from profile
- Create: `views/activitypub-moderation.njk` — Moderation settings page (list muted/blocked)
- Modify: `views/partials/ap-item-card.njk` — Add mute/block in item card dropdown menu
- Modify: `index.js` — Add moderation routes
- Modify: `locales/en.json` — Add moderation i18n strings

**Key Decisions / Notes:**

- Routes:
  - `POST /admin/activitypub/reader/mute` — body: `{ url: "actor-url" }` or `{ keyword: "text" }`
  - `POST /admin/activitypub/reader/unmute` — body: `{ url: "actor-url" }` or `{ keyword: "text" }`
  - `POST /admin/activitypub/reader/block` — body: `{ url: "actor-url" }` → also sends Block activity
  - `POST /admin/activitypub/reader/unblock` — body: `{ url: "actor-url" }` → sends Undo(Block)
  - `GET /admin/activitypub/reader/moderation` — View muted/blocked lists
- Mute: hide from timeline but don't notify the remote actor. Filter at query time: exclude items where `author.url` is in muted list or content matches muted keyword
- Block: send `Block` activity to remote actor via `ctx.sendActivity()` AND hide from timeline. On block: also remove existing timeline items from that actor. **Federation context injection** needed for Block/Undo(Block) — same plugin instance pattern as Task 7a.
- **CSRF protection:** All POST endpoints (mute/unmute/block/unblock) must validate CSRF token (reuse `lib/csrf.js` from Task 7a)
- Tab filtering implementation: `getTimelineItems()` accepts a `type` parameter. Map tabs:
  - All → no filter
  - Notes → `type: "note"`
  - Articles → `type: "article"`
  - Replies → items where `inReplyTo` is not null
  - Boosts → `type: "boost"`
  - Media → items where `photo`, `video`, or `audio` arrays are non-empty
- Each tab shows a count badge? No — too expensive on every page load. Just tab labels.
- Card dropdown (three dots menu): "Mute @user", "Block @user", "Mute keyword..."

**Definition of Done:**

- [ ] Muting an actor hides their posts from timeline
- [ ] Muting a keyword hides matching posts from timeline
- [ ] Blocking an actor sends Block activity and removes their posts
- [ ] Unblocking sends Undo(Block)
- [ ] Moderation settings page lists all muted actors, keywords, and blocked actors
- [ ] Can unmute/unblock from the settings page
- [ ] Tab filtering returns correct subset of timeline items
- [ ] Card dropdown has mute/block actions

**Verify:**

- Mute an actor → verify their posts disappear from timeline
- Block an actor → verify Block activity sent + posts removed
- Switch between tabs → verify correct filtering

---

### Task 11: Remote Profile View

**Objective:** Create a profile page for viewing remote actors, showing their info and recent posts, with follow/unfollow, mute, and block buttons.

**Dependencies:** Task 4, Task 7b, Task 10

**Files:**

- Modify: `lib/controllers/reader.js` — Add profile controller function
- Create: `views/activitypub-remote-profile.njk` — Remote actor profile view (**NOT** `activitypub-profile.njk` — that file already exists for the user's own profile editor)
- Modify: `assets/reader.css` — Add profile view styles
- Modify: `index.js` — Add profile route
- Modify: `locales/en.json` — Add profile i18n strings

**Key Decisions / Notes:**

- Route: `GET /admin/activitypub/reader/profile?url=actor-url` or `GET /admin/activitypub/reader/profile?handle=@user@instance`
- Fetch actor info via `ctx.lookupObject(url)` — returns Fedify Actor with name, summary, icon, image, followerCount, followingCount, etc.
- Show: avatar, header image, display name, handle, bio, follower/following counts, profile links
- Show recent posts from that actor in the timeline (filter `ap_timeline` by `author.url`)
- If the actor is not followed, posts won't be in the local timeline — show a message "Follow to see their posts" or attempt to fetch their outbox via `ctx.traverseCollection(outbox)` (limited, slow)
- Decision: For now, only show locally-stored posts (from following). If not following, show profile info only with a "Follow to see their posts in your timeline" CTA
- Action buttons: Follow/Unfollow (reuse existing `followActor`/`unfollowActor` methods from `index.js`), Mute, Block
- Link to external profile: "View on {instance}" link to the actor's URL

**Definition of Done:**

- [ ] Profile page renders remote actor info (avatar, name, handle, bio)
- [ ] Profile shows header image if available
- [ ] Profile shows follower/following counts
- [ ] Posts from that actor shown below profile (if following)
- [ ] Follow/unfollow button works
- [ ] Mute/block buttons work from profile
- [ ] "View on {instance}" external link present
- [ ] Graceful handling when actor lookup fails

**Verify:**

- Navigate to a followed actor's profile → verify info and posts display
- Follow/unfollow from profile → verify state changes
- Navigate to an unknown handle → verify graceful error

---

### Task 12: Remove Microsub Bridge

**Objective:** Remove all Microsub bridge code from the AP plugin — `storeTimelineItem()`, `getApChannelId()`, and the lazy `microsub_items`/`microsub_channels` collection accessors.

**Dependencies:** Task 2, Task 3, Task 4, Task 6 (all reader functionality must be working first)

**Files:**

- Modify: `lib/inbox-listeners.js` — Remove `storeTimelineItem()` function (lines 455-576), remove `getApChannelId()` function (lines 400-453), remove any remaining calls to these functions
- Modify: `index.js` — Remove lazy `microsub_items` and `microsub_channels` getter/accessors (lines 638-643), remove any `microsub` references from collection handling
- Modify: `lib/inbox-listeners.js` — Remove the `storeTimelineItem()` call in the Create handler (should already be replaced in Task 2, but verify)

**Key Decisions / Notes:**

- This is a cleanup task — all replacement functionality should already be working via Tasks 2-6
- The Microsub plugin itself remains fully functional — it still manages its own RSS/Atom feeds, channels, and items. We're only removing the AP plugin's code that bridges INTO Microsub collections
- After removal, the `microsub_items` collection may still contain old AP items (with `source.type: "activitypub"`) — these can be left in place or cleaned up manually by the user
- Verify that the Microsub plugin's "Fediverse" channel still works for non-AP content (it's created by `getApChannelId` which we're removing). If no non-AP content uses it, the channel becomes orphaned — that's fine.
- Test that the AP plugin starts cleanly without any Microsub collections referenced
- Bump version in `package.json` for this change since it removes a dependency

**Definition of Done:**

- [ ] `storeTimelineItem()` function removed from `inbox-listeners.js`
- [ ] `getApChannelId()` function removed from `inbox-listeners.js`
- [ ] No references to `microsub_items` or `microsub_channels` in any AP plugin file
- [ ] No `import` or `require` of Microsub-related modules
- [ ] Plugin starts without errors when Microsub plugin is not loaded
- [ ] Plugin starts without errors when Microsub plugin IS loaded (no conflict)
- [ ] Existing AP timeline/notification functionality unaffected
- [ ] Version bumped in `package.json`

**Verify:**

- `grep -r "microsub" /home/rick/code/indiekit-dev/indiekit-endpoint-activitypub/lib/ /home/rick/code/indiekit-dev/indiekit-endpoint-activitypub/index.js` — returns zero matches
- `node -e "import('./index.js')"` — plugin loads without errors
- Deploy to Cloudron → verify reader works, verify Microsub reader still works independently

---

### Task 13: Timeline Retention Cleanup

**Objective:** Implement automatic cleanup of old timeline items to prevent unbounded collection growth.

**Dependencies:** Task 1, Task 2

**Files:**

- Create: `lib/timeline-cleanup.js` — Retention cleanup function
- Modify: `index.js` — Schedule periodic cleanup (e.g., on server startup and via a setInterval)

**Key Decisions / Notes:**

- Keep the last 1000 timeline items (configurable via plugin options: `timelineRetention: 1000`)
- Cleanup runs on plugin `init()` and then every 24 hours via `setInterval`
- Implementation: `ap_timeline.deleteMany({ published: { $lt: oldestKeepDate } })` — find the published date of the 1000th newest item, delete everything older
- Alternative: count-based: `ap_timeline.find().sort({ published: -1 }).skip(1000).forEach(doc => delete)`
- Decision: Use count-based approach — simpler, handles edge cases where many items share the same date
- Also clean up corresponding `ap_interactions` entries for deleted timeline items (remove stale like/boost tracking)
- Log cleanup results: "Timeline cleanup: removed N items older than {date}"

**Definition of Done:**

- [ ] Cleanup function removes items beyond retention limit
- [ ] Cleanup runs on startup and periodically
- [ ] Retention limit is configurable via plugin options
- [ ] Stale `ap_interactions` entries cleaned up alongside timeline items
- [ ] Cleanup logged for diagnostics
- [ ] Tests verify retention limit is enforced

**Verify:**

- Insert 1050 test items → run cleanup → verify only 1000 remain
- Verify `ap_interactions` for removed items are also deleted

---

## Testing Strategy

- **Unit tests:** Storage functions (timeline CRUD, notification CRUD, moderation CRUD), data extraction helpers (`extractObjectData`, `extractActorInfo`), tab filtering logic
- **Integration tests:** Bash-based tests in `/home/rick/code/indiekit-dev/activitypub-tests/` — add new tests for reader endpoints (authenticated GET requests), interaction endpoints (POST like/boost), notification counts
- **Manual verification:**
  - Use `playwright-cli` to verify reader UI renders correctly
  - Send real AP interactions from a test Mastodon account to verify inbox→timeline→notification flow
  - Compose replies via both paths (Micropub and direct AP) and verify they appear on remote instances

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `ctx.lookupObject()` slow for remote actors (profile view) | High | Medium | Cache actor info in `ap_timeline` author fields; only call lookupObject once per profile visit, not per card |
| `ctx.sendActivity()` for likes/boosts may fail silently | Medium | Medium | Store interaction attempt in `ap_interactions` with status field; show error state in UI if delivery fails |
| Content warnings/sensitive flag not consistently set by remote servers | Medium | Low | Treat `summary` presence as CW signal (Mastodon convention); fall back to "Sensitive content" for `sensitive: true` without summary |
| Image gallery CSS breaks with very large images | Low | Low | Use `object-fit: cover` with max-height constraints; all images in grid cells |
| Removing Microsub bridge while user still has AP items in Microsub channel | Medium | Low | Leave existing items in `microsub_items` untouched; they'll still be readable through the Microsub reader. Only new AP items go to `ap_timeline` |
| Alpine.js optimistic updates for like/boost may desync with server state | Medium | Low | On page reload, always read server state from timeline items; track interactions in `ap_interactions` collection |
| CSRF attacks on POST endpoints could trigger unwanted AP activities | Medium | High | All POST endpoints validate per-session CSRF token via `lib/csrf.js`; token embedded in forms and `fetch()` headers |
| Timeline collection grows unbounded | High | Medium | Task 13 implements automatic retention cleanup (keep last 1000 items, configurable) |
| Announce wraps a deleted/inaccessible object | Medium | Low | If `activity.getObject()` returns null or fails, skip storing the boost and log a warning. Don't crash the inbox handler. |
| Remote actor lookup fails during profile view | Medium | Low | Show error message "Could not load profile — the server may be temporarily unavailable" with retry link. Don't crash the page. |

## Open Questions

- Should there be a "Refresh timeline" button/action, or does it automatically show new items on page reload? → Decision: Automatic on reload for MVP; real-time updates (SSE/polling) deferred
- Should the AP reader be the default landing page when navigating to `/admin/activitypub/`? → Decision: Yes, redirect `/admin/activitypub/` to `/admin/activitypub/reader` as the primary view. Dashboard remains accessible via sub-navigation within the reader layout. The top-level sidebar `get navigationItems()` returns "Reader" linking to `/activitypub/reader`.
- What's the maximum number of timeline items to store before cleanup? → Decision: Keep last 1000 items; auto-delete older items on a weekly basis

### Deferred Ideas

- Real-time timeline updates via Server-Sent Events (SSE) or periodic polling
- Lists feature (organizing follows into named groups with separate timelines)
- Thread view (expanding full conversation thread from a reply)
- Mastodon REST API compatibility layer for mobile clients
- Push notifications for new mentions/replies
- Image lightbox for gallery view
- Infinite scroll instead of pagination
- Timeline item search
