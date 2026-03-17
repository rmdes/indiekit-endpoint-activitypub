# CLAUDE.md — @rmdes/indiekit-endpoint-activitypub

AI agent instructions for working on this codebase. Read this entire file before making any changes.

## What This Is

An Indiekit plugin that adds full ActivityPub federation via [Fedify](https://fedify.dev). It turns an Indiekit-powered IndieWeb site into a fediverse actor — discoverable, followable, and interactive from Mastodon, Misskey, Pixelfed, Lemmy, etc.

**npm:** `@rmdes/indiekit-endpoint-activitypub`
**Version:** See `package.json`
**Node:** >=22
**Module system:** ESM (`"type": "module"`)

## Architecture Overview

```
index.js                          ← Plugin entry, route registration, syndicator
├── lib/federation-setup.js       ← Fedify Federation instance, dispatchers, collections
├── lib/federation-bridge.js      ← Express ↔ Fedify request/response bridge
├── lib/inbox-listeners.js        ← Fedify inbox listener registration + reply forwarding
├── lib/inbox-handlers.js         ← Async inbox activity handlers (Create, Like, Announce, etc.)
├── lib/inbox-queue.js            ← Persistent MongoDB-backed async inbox processing queue
├── lib/outbox-failure.js         ← Outbox delivery failure handling (410 cleanup, 404 strikes, strike reset)
├── lib/jf2-to-as2.js             ← JF2 → ActivityStreams conversion (plain JSON + Fedify vocab)
├── lib/kv-store.js               ← MongoDB-backed KvStore for Fedify (get/set/delete/list)
├── lib/activity-log.js           ← Activity logging to ap_activities
├── lib/item-processing.js        ← Unified item processing pipeline (moderation, quotes, interactions, rendering)
├── lib/timeline-store.js         ← Timeline item extraction + sanitization
├── lib/timeline-cleanup.js       ← Retention-based timeline pruning
├── lib/og-unfurl.js              ← Open Graph link previews + quote enrichment
├── lib/key-refresh.js            ← Remote actor key freshness tracking (skip redundant re-fetches)
├── lib/redis-cache.js            ← Redis-cached actor lookups (cachedQuery wrapper)
├── lib/lookup-helpers.js         ← WebFinger/actor resolution utilities
├── lib/lookup-cache.js           ← In-memory LRU cache for actor lookups
├── lib/resolve-author.js         ← Author resolution with fallback chain
├── lib/content-utils.js          ← Content sanitization and text processing
├── lib/emoji-utils.js            ← Custom emoji detection and rendering
├── lib/fedidb.js                 ← FediDB integration for popular accounts
├── lib/batch-refollow.js         ← Gradual re-follow for imported Mastodon accounts
├── lib/migration.js              ← CSV parsing + WebFinger resolution for Mastodon import
├── lib/csrf.js                   ← CSRF token generation/validation
├── lib/migrations/
│   └── separate-mentions.js      ← Data migration: split mentions from notifications
├── lib/storage/
│   ├── timeline.js               ← Timeline CRUD with cursor pagination
│   ├── notifications.js          ← Notification CRUD with read/unread tracking
│   ├── moderation.js             ← Mute/block storage
│   ├── server-blocks.js          ← Server-level domain blocking
│   ├── followed-tags.js          ← Hashtag follow/unfollow storage
│   └── messages.js               ← Direct message storage
├── lib/controllers/              ← Express route handlers (admin UI)
│   ├── dashboard.js, reader.js, compose.js, profile.js, profile.remote.js
│   ├── public-profile.js         ← Public profile page (HTML fallback for actor URL)
│   ├── explore.js, explore-utils.js ← Explore public Mastodon timelines
│   ├── hashtag-explore.js        ← Cross-instance hashtag search
│   ├── tag-timeline.js           ← Posts filtered by hashtag
│   ├── post-detail.js            ← Single post detail view
│   ├── api-timeline.js           ← AJAX API for infinite scroll + new post count
│   ├── followers.js, following.js, activities.js
│   ├── featured.js, featured-tags.js
│   ├── interactions.js, interactions-like.js, interactions-boost.js
│   ├── moderation.js, migrate.js, refollow.js
│   ├── messages.js               ← Direct message UI
│   ├── follow-requests.js        ← Manual follow approval UI
│   ├── follow-tag.js             ← Hashtag follow/unfollow actions
│   ├── tabs.js                   ← Explore tab management
│   ├── my-profile.js             ← Self-profile view
│   ├── resolve.js                ← Actor/post resolution endpoint
│   ├── authorize-interaction.js  ← Remote interaction authorization
│   ├── federation-mgmt.js        ← Federation management (server blocks)
│   └── federation-delete.js      ← Account deletion / federation cleanup
├── views/                        ← Nunjucks templates
│   ├── activitypub-*.njk         ← Page templates
│   ├── layouts/ap-reader.njk     ← Reader layout (NOT reader.njk — see gotcha below)
│   └── partials/                 ← Shared components (item card, quote embed, link preview, media)
├── assets/
│   ├── reader.css                ← Reader UI styles
│   ├── reader-infinite-scroll.js ← Alpine.js components (infinite scroll, new posts banner, read tracking)
│   ├── reader-tabs.js            ← Alpine.js tab persistence
│   └── icon.svg                  ← Plugin icon
└── locales/en.json               ← i18n strings
```

## Data Flow

```
Outbound: Indiekit post → syndicator.syndicate() → jf2ToAS2Activity() → ctx.sendActivity() → follower inboxes
          Delivery failure → outbox-failure.js → 410: full cleanup | 404: strike system → eventual cleanup
Inbound:  Remote inbox POST → Fedify → inbox-listeners.js → ap_inbox_queue → inbox-handlers.js → MongoDB
          Reply forwarding: inbox-listeners.js checks if reply is to our post → ctx.forwardActivity() → follower inboxes
Reader:   Followed account posts → Create inbox → timeline-store → ap_timeline → reader UI
Explore:  Public Mastodon API → fetchMastodonTimeline() → mapMastodonToItem() → explore UI

All views (reader, explore, tag timeline, hashtag explore, API endpoints) share a single
processing pipeline via item-processing.js:
  items → applyTabFilter() → loadModerationData() → postProcessItems() → render
```

## MongoDB Collections

| Collection | Purpose | Key fields |
|---|---|---|
| `ap_followers` | Accounts following us | `actorUrl` (unique), `inbox`, `sharedInbox`, `source`, `deliveryFailures`, `firstFailureAt`, `lastFailureAt` |
| `ap_following` | Accounts we follow | `actorUrl` (unique), `source`, `acceptedAt` |
| `ap_activities` | Activity log (TTL-indexed) | `direction`, `type`, `actorUrl`, `objectUrl`, `receivedAt` |
| `ap_keys` | Cryptographic key pairs | `type` ("rsa" or "ed25519"), key material |
| `ap_kv` | Fedify KvStore + job state | `_id` (key path), `value` |
| `ap_profile` | Actor profile (single doc) | `name`, `summary`, `icon`, `attachments`, `actorType` |
| `ap_featured` | Pinned posts | `postUrl`, `pinnedAt` |
| `ap_featured_tags` | Featured hashtags | `tag`, `addedAt` |
| `ap_timeline` | Reader timeline items | `uid` (unique), `published`, `author`, `content`, `visibility`, `isContext` |
| `ap_notifications` | Likes, boosts, follows, mentions | `uid` (unique), `type`, `read` |
| `ap_muted` | Muted actors/keywords | `url` or `keyword` |
| `ap_blocked` | Blocked actors | `url` |
| `ap_interactions` | Like/boost tracking per post | `objectUrl`, `type` |
| `ap_messages` | Direct messages | `uid` (unique), `conversationId`, `author`, `content` |
| `ap_followed_tags` | Hashtags we follow | `tag` (unique) |
| `ap_explore_tabs` | Saved explore instances | `instance` (unique), `label` |
| `ap_reports` | Outbound Flag activities | `actorUrl`, `reportedAt` |
| `ap_pending_follows` | Follow requests awaiting approval | `actorUrl` (unique), `receivedAt` |
| `ap_blocked_servers` | Blocked server domains | `domain` (unique) |
| `ap_key_freshness` | Remote actor key verification timestamps | `actorUrl` (unique), `lastVerifiedAt` |
| `ap_inbox_queue` | Persistent async inbox queue | `activityId`, `status`, `enqueuedAt` |

## Critical Patterns and Gotchas

### 1. Express ↔ Fedify Bridge (CUSTOM — NOT @fedify/express)

We **cannot** use `@fedify/express`'s `integrateFederation()` because Indiekit mounts plugins at sub-paths. Express strips the mount prefix from `req.url`, breaking Fedify's URI template matching. **Verified in Fedify 2.0**: `@fedify/express` still uses `req.url` (not `req.originalUrl`), so the custom bridge remains necessary. Instead, `federation-bridge.js` uses `req.originalUrl` to build the full URL.

The bridge also **reconstructs POST bodies** from `req.body` when Express body parser has already consumed the request stream (checked via `req.readable === false`). Without this, POST handlers in Fedify (e.g. the `@fedify/debugger` login form) receive empty bodies and fail with `"Response body object should not be disturbed or locked"`.

**If you see path-matching issues with Fedify, check that `req.originalUrl` is being used, not `req.url`.**

### 2. Content Negotiation Route — GET Only

The `contentNegotiationRoutes` router is mounted at `/` (root). It MUST only pass `GET`/`HEAD` requests to Fedify. Passing `POST`/`PUT`/`DELETE` would cause `fromExpressRequest()` to consume the body stream via `Readable.toWeb(req)`, breaking Express body-parsed routes downstream (admin forms, Micropub, etc.).

### 3. Skip Fedify for Admin Routes

In `routesPublic`, the middleware skips paths starting with `/admin`. Without this, Fedify would intercept admin UI requests and return 404/406 responses instead of letting Express serve the authenticated pages.

### 4. Authenticated Document Loader for Inbox Handlers

All `.getObject()` / `.getActor()` / `.getTarget()` calls in inbox handlers **must** pass an authenticated `DocumentLoader` to sign outbound fetches. Without this, requests to Authorized Fetch (Secure Mode) servers like hachyderm.io fail with 401.

```javascript
const authLoader = await ctx.getDocumentLoader({ identifier: handle });
const actor = await activity.getActor({ documentLoader: authLoader });
const object = await activity.getObject({ documentLoader: authLoader });
```

The `getAuthLoader` helper in `inbox-listeners.js` wraps this pattern. The authenticated loader is also passed through to `extractObjectData()` and `extractActorInfo()` in `timeline-store.js` so that `.getAttributedTo()`, `.getIcon()`, `.getTags()`, and `.getAttachments()` also sign their fetches.

**Still prefer** `.objectId?.href` and `.actorId?.href` (zero network requests) when you only need the URL — e.g. Like, Delete, and the filter check in Announce. Only use the fetching getters when you need the full object, and **always wrap in try-catch**.

### 5. Accept(Follow) Matching — Don't Check Inner Object Type

Fedify often resolves the inner object of `Accept` to a `Person` (the Follow's target) rather than the `Follow` itself. The Accept handler matches against `ap_following` by actor URL instead of inspecting `inner instanceof Follow`.

### 6. Filter Inbound Likes/Announces to Our Content Only

Without filtering, the inbox logs every Like/Announce from every federated server — including reactions to other people's content that happens to flow through shared inboxes. Check `objectId.startsWith(publicationUrl)` before logging.

### 7. Nunjucks Template Name Collisions

Template names resolve across ALL registered plugin view directories. If two plugins have `views/layouts/reader.njk`, Nunjucks loads whichever it finds first (often wrong). The reader layout is named `ap-reader.njk` to avoid collision with `@rmdes/indiekit-endpoint-microsub`'s `reader.njk`.

**Never name a layout/template with a generic name that another plugin might use.**

### 8. Express 5 — No redirect("back")

Express 5 removed the `"back"` magic keyword from `response.redirect()`. It's treated as a literal URL, causing 404s at paths like `/admin/featured/back`. Always use explicit redirect paths.

### 9. Attachment Array Workaround (Mastodon Compatibility)

JSON-LD compaction collapses single-element arrays to plain objects. Mastodon's `update_account_fields` checks `attachment.is_a?(Array)` and silently skips if it's not an array. `sendFedifyResponse()` in `federation-bridge.js` forces `attachment` to always be an array.

### 10. WORKAROUND: Endpoints `as:Endpoints` Type Stripping

**File:** `lib/federation-bridge.js` (in `sendFedifyResponse()`)
**Upstream issue:** [fedify#576](https://github.com/fedify-dev/fedify/issues/576) — FIXED in Fedify 2.1.0
**Workaround:** `delete json.endpoints.type` strips the invalid `"type": "as:Endpoints"` from actor JSON.
**Remove when:** Upgrading to Fedify ≥ 2.1.0.

### 11. KNOWN ISSUE: PropertyValue Attachment Type Validation

**Upstream issue:** [fedify#629](https://github.com/fedify-dev/fedify/issues/629) — OPEN
**Problem:** `PropertyValue` (schema.org type) is not a valid AS2 Object/Link, so browser.pub rejects `/attachment`. Every Mastodon-compatible server emits this — cannot remove without breaking profile fields.
**Workaround:** None applied (would break Mastodon compatibility). Documented as a known browser.pub strictness issue.

### 12. Profile Links — Express qs Body Parser Key Mismatch

`express.urlencoded({ extended: true })` uses `qs` which strips `[]` from array field names. HTML fields named `link_name[]` arrive as `request.body.link_name` (not `request.body["link_name[]"]`). The profile controller reads `link_name` and `link_value`, NOT `link_name[]`.

### 13. Author Resolution Fallback Chain

`extractObjectData()` in `timeline-store.js` uses a multi-strategy fallback:
1. `object.getAttributedTo()` — async, may fail with Authorized Fetch
2. `options.actorFallback` — the activity's actor (passed from Create handler)
3. `object.attribution` / `object.attributedTo` — plain object properties
4. `object.attributionIds` — non-fetching URL array with username extraction from common patterns (`/@name`, `/users/name`)

Without this chain, many timeline items show "Unknown" as the author.

### 14. Username Extraction from Actor URLs

When extracting usernames from attribution IDs, handle multiple URL patterns:
- `/@username` (Mastodon)
- `/users/username` (Mastodon, Indiekit)
- `/ap/users/12345/` (numeric IDs on some platforms)

The regex was previously matching "users" instead of the actual username from `/users/NatalieDavis`.

### 15. Empty Boost Filtering

Lemmy/PieFed send Announce activities where the boosted object resolves to an activity ID instead of a Note/Article with actual content. Check `object.content || object.name` before storing to avoid empty cards in the timeline.

### 16. Temporal.Instant for Fedify Dates

Fedify uses `@js-temporal/polyfill` for dates. When setting `published` on Fedify objects, use `Temporal.Instant.from(isoString)`. When reading Fedify dates in inbox handlers, use `String(object.published)` to get ISO strings — NOT `new Date(object.published)` which causes `TypeError`.

### 17. LogTape — Configure Once Only

`@logtape/logtape`'s `configure()` can only be called once per process. The module-level `_logtapeConfigured` flag prevents duplicate configuration. If configure fails (e.g., another plugin already configured it), catch the error silently.

When the debug dashboard is enabled (`debugDashboard: true`), LogTape configuration is **skipped entirely** because `@fedify/debugger` configures its own LogTape sink for the dashboard UI.

### 18. .authorize() Intentionally NOT Chained on Actor Dispatcher

Fedify's `.authorize()` triggers HTTP Signature verification on every GET to the actor endpoint. Servers requiring Authorized Fetch cause infinite loops: Fedify tries to fetch their key → they return 401 → Fedify retries → 500 errors. Re-enable when Fedify supports authenticated document loading for outgoing fetches.

### 19. Delivery Queue Must Be Started

`federation.startQueue()` MUST be called after setup. Without it, `ctx.sendActivity()` enqueues tasks but the message queue never processes them — activities are never delivered.

### 20. Shared Key Dispatcher for Shared Inbox

`inboxChain.setSharedKeyDispatcher()` tells Fedify to use our actor's key pair when verifying HTTP Signatures on the shared inbox. Without this, servers like hachyderm.io (which requires Authorized Fetch) have their signatures rejected.

### 21. Fedify 2.0 Modular Imports

Fedify 2.0 uses modular entry points instead of a single barrel export. Imports must use the correct subpath:

```javascript
// Core federation infra
import { createFederation, InProcessMessageQueue } from "@fedify/fedify";

// Crypto operations (key generation, import/export)
import { exportJwk, generateCryptoKeyPair, importJwk } from "@fedify/fedify/sig";

// ActivityStreams vocabulary types
import { Person, Note, Article, Create, Follow, ... } from "@fedify/fedify/vocab";

// WRONG (Fedify 1.x style) — these no longer work:
// import { Person, createFederation, exportJwk } from "@fedify/fedify";
```

### 22. importSpki Removed in Fedify 2.0

Fedify 1.x exported `importSpki()` for loading PEM public keys. This was removed in 2.0. The local `importSpkiPem()` function in `federation-setup.js` replaces it using the Web Crypto API directly (`crypto.subtle.importKey("spki", ...)`). Similarly, `importPkcs8Pem()` handles private keys in PKCS#8 format.

### 23. KvStore Requires list() in Fedify 2.0

Fedify 2.0 added a `list(prefix?)` method to the KvStore interface. It must return an `AsyncIterable<{ key: string[], value: unknown }>`. The `MongoKvStore` in `kv-store.js` implements this as an async generator that queries MongoDB with a regex prefix match on the `_id` field.

### 24. Debug Dashboard Body Consumption

The `@fedify/debugger` login form POSTs `application/x-www-form-urlencoded` data. Because Express's body parser runs before the Fedify bridge, the POST body stream is already consumed (`req.readable === false`). The bridge in `federation-bridge.js` detects this and reconstructs the body from `req.body`. Without this, the debugger's login handler receives an empty body and throws `"Response body object should not be disturbed or locked"`. See also Gotcha #1.

### 25. Unified Item Processing Pipeline

All views that display timeline items — reader, explore, tag timeline, hashtag explore, and their AJAX API counterparts — **must** use the shared pipeline in `lib/item-processing.js`. Never duplicate moderation filtering, quote stripping, interaction map building, or card rendering in individual controllers.

The pipeline flow is:

```javascript
import { postProcessItems, applyTabFilter, loadModerationData, renderItemCards } from "../item-processing.js";

// 1. Get raw items (from MongoDB or Mastodon API)
// 2. Filter by tab/type (optional)
const filtered = applyTabFilter(items, tab);
// 3. Load moderation data once
const moderation = await loadModerationData(modCollections);
// 4. Run unified pipeline (filters muted/blocked, strips quote refs, builds interaction map)
const { items: processed, interactionMap } = await postProcessItems(filtered, { moderation, interactionsCol });
// 5. For AJAX endpoints, render HTML server-side
const html = await renderItemCards(processed, request, { interactionMap, mountPath, csrfToken });
```

**Key functions:**
- `postProcessItems()` — orchestrates moderation → quote stripping → interaction map
- `applyModerationFilters()` — filters items by muted URLs, keywords, blocked URLs
- `stripQuoteReferences()` — removes inline `RE: <link>` paragraphs when quote embed exists
- `buildInteractionMap()` — queries `ap_interactions` for like/boost state per item
- `applyTabFilter()` — filters items by type tab (notes, articles, replies, boosts, media)
- `renderItemCards()` — server-side Nunjucks rendering of `ap-item-card.njk` for AJAX responses
- `loadModerationData()` — convenience wrapper to load muted/blocked data from MongoDB

**If you add a new view that shows timeline items, use this pipeline.** Do not inline the logic.

### 26. Unified Infinite Scroll Alpine Component

All views with infinite scroll use a single `apInfiniteScroll` Alpine.js component (in `assets/reader-infinite-scroll.js`), parameterized via data attributes on the container element:

```html
<div class="ap-load-more"
  data-cursor="{{ cursor }}"
  data-api-url="{{ mountPath }}/admin/reader/api/timeline"
  data-cursor-param="before"        <!-- query param name sent to API -->
  data-cursor-field="before"         <!-- response JSON field for next cursor -->
  data-timeline-id="ap-timeline"     <!-- DOM ID to append HTML into -->
  data-extra-params='{{ extraJson }}'  <!-- JSON object of additional query params -->
  data-hide-pagination="pagination-id" <!-- optional: ID of no-JS pagination to hide -->
  x-data="apInfiniteScroll()"
  x-init="init()">
```

**Do not create separate scroll components for new views.** Configure the existing one with appropriate data attributes. The explore view uses `data-cursor-param="max_id"` and `data-cursor-field="maxId"` (Mastodon API conventions), while the reader uses `data-cursor-param="before"` and `data-cursor-field="before"`.

### 27. Quote Embeds and Enrichment

Posts that quote another post (Mastodon quote feature via FEP-044f) are rendered with an embedded card showing the quoted post's author, content, and timestamp. The data flow:

1. **Ingest:** `extractObjectData()` reads `object.quoteUrl` (Fedify reads `as:quoteUrl`, `misskey:_misskey_quote`, `fedibird:quoteUri`)
2. **Enrichment:** `fetchAndStoreQuote()` in `og-unfurl.js` fetches the quoted post via `ctx.lookupObject()`, extracts data with `extractObjectData()`, and stores it as `quote` on the timeline item
3. **On-demand:** `post-detail.js` fetches quotes on demand for items that have `quoteUrl` but no stored `quote` data (pre-existing items)
4. **Rendering:** `partials/ap-quote-embed.njk` renders the embedded card; `stripQuoteReferences()` removes the inline `RE: <link>` paragraph to avoid duplication

### 28. Async Inbox Processing (v2.14.0+)

Inbound activities follow a two-stage pattern: `inbox-listeners.js` receives activities from Fedify, persists them to `ap_inbox_queue`, then `inbox-handlers.js` processes them asynchronously. This ensures no data loss if the server crashes mid-processing. Reply forwarding (`ctx.forwardActivity()`) happens synchronously in `inbox-listeners.js` because `forwardActivity()` is only available on `InboxContext`, not the base `Context` used by the queue processor.

### 29. Outbox Delivery Failure Handling (v2.15.0+)

`lib/outbox-failure.js` handles permanent delivery failures reported by Fedify's `setOutboxPermanentFailureHandler`:

- **410 Gone** → Immediate full cleanup: deletes follower from `ap_followers`, their items from `ap_timeline` (by `author.url`), their notifications from `ap_notifications` (by `actorUrl`)
- **404 Not Found** → Strike system: increments `deliveryFailures` on the follower doc, sets `firstFailureAt` via `$setOnInsert`. After 3 strikes over 7+ days, triggers the same full cleanup as 410
- **Strike reset** → `resetDeliveryStrikes()` is called in `inbox-listeners.js` after `touchKeyFreshness()` for every inbound activity type (except Block). If an actor is sending us activities, they're alive — `$unset` the strike fields

### 30. Reply Chain Fetching and Reply Forwarding (v2.15.0+)

- `fetchReplyChain()` in `inbox-handlers.js`: When a reply arrives, recursively fetches parent posts up to 5 levels deep using `object.getReplyTarget()`. Ancestors are stored with `isContext: true` flag. Uses `$setOnInsert` upsert so re-fetching ancestors is a no-op.
- Reply forwarding in `inbox-listeners.js`: When a Create activity is a reply to one of our posts (checked via `inReplyTo.startsWith(publicationUrl)`) and is addressed to the public collection, calls `ctx.forwardActivity()` to re-deliver the reply to our followers' inboxes.

### 31. Write-Time Visibility Classification (v2.15.0+)

`computeVisibility(object)` in `inbox-handlers.js` classifies posts at ingest time based on `to`/`cc` fields:
- `to` includes `https://www.w3.org/ns/activitystreams#Public` → `"public"`
- `cc` includes Public → `"unlisted"`
- Neither → `"private"` or `"direct"` (based on whether followers collection is in `to`)

The `visibility` field is stored on `ap_timeline` documents for future filtering.

### 32. Server Blocking (v2.14.0+)

`lib/storage/server-blocks.js` manages domain-level blocks stored in `ap_blocked_servers`. When a server is blocked, all inbound activities from that domain are rejected in `inbox-listeners.js` before any processing occurs. The `federation-mgmt.js` controller provides the admin UI.

### 33. Key Freshness Tracking (v2.14.0+)

`lib/key-refresh.js` tracks when remote actor keys were last verified in `ap_key_freshness`. `touchKeyFreshness()` is called for every inbound activity. This allows skipping redundant key re-fetches for actors we've recently verified, reducing network round-trips.

## Date Handling Convention

**All dates MUST be stored as ISO 8601 strings.** This is mandatory across all Indiekit plugins.

```javascript
// CORRECT
followedAt: new Date().toISOString()
published: String(fedifyObject.published)  // Temporal → string

// WRONG — crashes Nunjucks | date filter
followedAt: new Date()
published: new Date(fedifyObject.published)
```

The Nunjucks `| date` filter calls `date-fns parseISO()` which only accepts ISO strings. `Date` objects cause `"dateString.split is not a function"` crashes.

## Batch Re-follow State Machine

```
import → refollow:pending → refollow:sent → federation  (happy path: Accept received)
import → refollow:pending → refollow:sent → refollow:failed (after 3 retries)
```

- `import`: Imported from Mastodon CSV, no Follow sent yet
- `refollow:pending`: Claimed by batch processor, being processed
- `refollow:sent`: Follow activity sent, awaiting Accept
- `federation`: Accept received, fully federated
- `refollow:failed`: Max retries exceeded

On restart, `refollow:pending` entries are reset to `import` to prevent stale claims.

## Plugin Lifecycle

1. `constructor()` — Merges options with defaults
2. `init(Indiekit)` — Called by Indiekit during startup:
   - Stores `publication.me` as `_publicationUrl`
   - Registers 13 MongoDB collections with indexes
   - Seeds actor profile from config (first run only)
   - Calls `setupFederation()` which creates Fedify instance + starts queue
   - Registers endpoint (mounts routes) and syndicator
   - Starts batch re-follow processor (10s delay)
   - Schedules timeline cleanup (on startup + every 24h)

## Route Structure

| Method | Path | Handler | Auth |
|---|---|---|---|
| `*` | `/.well-known/*` | Fedify (WebFinger, NodeInfo) | No |
| `*` | `{mount}/users/*`, `{mount}/inbox` | Fedify (actor, inbox, outbox, collections) | No (HTTP Sig) |
| `GET` | `{mount}/` | Dashboard | Yes (IndieAuth) |
| `GET` | `{mount}/admin/reader` | Timeline reader | Yes |
| `GET` | `{mount}/admin/reader/explore` | Explore public Mastodon timelines | Yes |
| `GET` | `{mount}/admin/reader/explore/hashtag` | Cross-instance hashtag search | Yes |
| `GET` | `{mount}/admin/reader/tag` | Tag timeline (posts by hashtag) | Yes |
| `GET` | `{mount}/admin/reader/post` | Post detail view | Yes |
| `GET` | `{mount}/admin/reader/notifications` | Notifications | Yes |
| `GET` | `{mount}/admin/reader/api/timeline` | AJAX timeline API (infinite scroll) | Yes |
| `GET` | `{mount}/admin/reader/api/timeline/count-new` | New post count API (polling) | Yes |
| `POST` | `{mount}/admin/reader/api/timeline/mark-read` | Mark posts as read API | Yes |
| `GET` | `{mount}/admin/reader/api/explore` | AJAX explore API (infinite scroll) | Yes |
| `POST` | `{mount}/admin/reader/compose` | Compose reply | Yes |
| `POST` | `{mount}/admin/reader/like,unlike,boost,unboost` | Interactions | Yes |
| `POST` | `{mount}/admin/reader/follow,unfollow` | Follow/unfollow | Yes |
| `POST` | `{mount}/admin/reader/follow-tag,unfollow-tag` | Follow/unfollow hashtag | Yes |
| `GET` | `{mount}/admin/reader/profile` | Remote profile view | Yes |
| `GET` | `{mount}/admin/reader/moderation` | Moderation dashboard | Yes |
| `POST` | `{mount}/admin/reader/mute,unmute,block,unblock` | Moderation actions | Yes |
| `GET/POST` | `{mount}/admin/reader/messages` | Direct messages | Yes |
| `GET/POST` | `{mount}/admin/follow-requests` | Manual follow approval | Yes |
| `POST` | `{mount}/admin/reader/follow-tag,unfollow-tag` | Follow/unfollow hashtag | Yes |
| `GET/POST` | `{mount}/admin/federation` | Server blocking management | Yes |
| `GET` | `{mount}/admin/followers,following,activities` | Lists | Yes |
| `GET/POST` | `{mount}/admin/profile` | Actor profile editor | Yes |
| `GET/POST` | `{mount}/admin/featured` | Pinned posts | Yes |
| `GET/POST` | `{mount}/admin/tags` | Featured tags | Yes |
| `GET/POST` | `{mount}/admin/migrate` | Mastodon migration | Yes |
| `*` | `{mount}/admin/refollow/*` | Batch refollow control | Yes |
| `*` | `{mount}/__debug__/*` | Fedify debug dashboard (if enabled) | Password |
| `GET` | `{mount}/users/:identifier` | Public profile page (HTML fallback) | No |
| `GET` | `/*` (root) | Content negotiation (AP clients only) | No |

## Dependencies

| Package | Purpose |
|---|---|
| `@fedify/fedify` | ActivityPub federation framework (v2.0+) |
| `@fedify/debugger` | Optional debug dashboard with OpenTelemetry tracing |
| `@fedify/redis` | Redis message queue for delivery |
| `@js-temporal/polyfill` | Temporal API for Fedify date handling |
| `ioredis` | Redis client |
| `sanitize-html` | XSS prevention for timeline/notification content |
| `unfurl.js` | Open Graph metadata extraction for link previews |
| `express` | Route handling (peer: Indiekit provides it) |

## Configuration Options

```javascript
{
  mountPath: "/activitypub",         // URL prefix for all routes
  actor: {
    handle: "rick",                  // Fediverse username
    name: "Ricardo Mendes",          // Display name (seeds profile)
    summary: "",                     // Bio (seeds profile)
    icon: "",                        // Avatar URL (seeds profile)
  },
  checked: true,                     // Syndicator checked by default
  alsoKnownAs: "",                   // Mastodon migration alias
  activityRetentionDays: 90,         // TTL for ap_activities (0 = forever)
  storeRawActivities: false,         // Store full JSON of inbound activities
  redisUrl: "",                      // Redis for delivery queue (empty = in-process)
  parallelWorkers: 5,               // Parallel delivery workers (with Redis)
  actorType: "Person",              // Person | Service | Organization | Group
  logLevel: "warning",             // Fedify log level: debug | info | warning | error | fatal
  timelineRetention: 1000,          // Max timeline items (0 = unlimited)
  notificationRetentionDays: 30,    // Days to keep notifications (0 = forever)
  debugDashboard: false,            // Enable @fedify/debugger dashboard at {mount}/__debug__/
  debugPassword: "",                // Password for debug dashboard (required if dashboard enabled)
}
```

## Publishing Workflow

1. Edit code in this repo
2. Bump version in `package.json` (npm rejects duplicate versions)
3. Commit and push
4. **STOP** — user must run `npm publish` manually (requires OTP)
5. After publish confirmation, update Dockerfile version in `indiekit-cloudron/`
6. `cloudron build --no-cache && cloudron update --app rmendes.net --no-backup`

## Testing

No automated test suite. Manual testing against real fediverse servers:

```bash
# WebFinger
curl -s "https://rmendes.net/.well-known/webfinger?resource=acct:rick@rmendes.net" | jq .

# Actor document
curl -s -H "Accept: application/activity+json" "https://rmendes.net/" | jq .

# NodeInfo
curl -s "https://rmendes.net/nodeinfo/2.1" | jq .

# Search from Mastodon for @rick@rmendes.net
```

## CSS Conventions

The reader CSS (`assets/reader.css`) uses Indiekit's theme custom properties for automatic dark mode support:
- `--color-on-background` (not `--color-text`)
- `--color-on-offset` (not `--color-text-muted`)
- `--border-radius-small` (not `--border-radius`)
- `--color-red45`, `--color-green50`, etc. (not hardcoded hex)

Post types are differentiated by left border color: purple (notes), green (articles), yellow (boosts), primary (replies).
