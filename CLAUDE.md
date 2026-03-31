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
index.js                          ← Plugin entry, route registration, lifecycle orchestration
├── lib/federation-setup.js       ← Fedify Federation instance, dispatchers, collections
├── lib/federation-bridge.js      ← Express ↔ Fedify request/response bridge
├── lib/federation-actions.js     ← Facade for controller federation access (context creation, actor resolution)
├── lib/inbox-listeners.js        ← Fedify inbox listener registration + reply forwarding
├── lib/inbox-handlers.js         ← Async inbox activity handlers (Create, Like, Announce, etc.)
├── lib/inbox-queue.js            ← Persistent MongoDB-backed async inbox processing queue
├── lib/outbox-failure.js         ← Outbox delivery failure handling (410 cleanup, 404 strikes, strike reset)
├── lib/batch-broadcast.js        ← Shared batch delivery to followers (dedup, batching, logging)
├── lib/jf2-to-as2.js             ← JF2 → ActivityStreams conversion (plain JSON + Fedify vocab)
├── lib/syndicator.js             ← Indiekit syndicator factory (JF2→AS2, mention resolution, delivery)
├── lib/kv-store.js               ← MongoDB-backed KvStore for Fedify (get/set/delete/list)
├── lib/init-indexes.js           ← MongoDB index creation (idempotent startup)
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
├── lib/mastodon/                 ← Mastodon Client API (Phanpy/Elk/Moshidon/Fedilab compatibility)
│   ├── router.js                 ← Main router: body parsers, CORS, token resolution, sub-routers
│   ├── backfill-timeline.js      ← Startup backfill: posts collection → ap_timeline
│   ├── entities/                 ← Mastodon JSON entity serializers
│   │   ├── account.js            ← Account entity (local + remote, with stats cache enrichment)
│   │   ├── status.js             ← Status entity (published-based cursor IDs, own-post detection)
│   │   ├── notification.js       ← Notification entity
│   │   ├── sanitize.js           ← HTML sanitization for API responses
│   │   ├── relationship.js       ← Relationship entity
│   │   ├── media.js              ← Media attachment entity
│   │   └── instance.js           ← Instance info entity
│   ├── helpers/
│   │   ├── pagination.js         ← Published-date cursor pagination (NOT ObjectId-based)
│   │   ├── id-mapping.js         ← Deterministic account IDs: sha256(actorUrl).slice(0,24)
│   │   ├── interactions.js       ← Like/boost/bookmark via Fedify AP activities
│   │   ├── resolve-account.js    ← Remote account resolution via Fedify WebFinger + actor fetch
│   │   ├── account-cache.js      ← In-memory LRU cache for account stats (500 entries, 1h TTL)
│   │   └── enrich-accounts.js    ← Batch-enrich embedded account stats in timeline responses
│   ├── middleware/
│   │   ├── cors.js               ← CORS for browser-based SPA clients
│   │   ├── token-required.js     ← Bearer token → ap_oauth_tokens lookup
│   │   ├── scope-required.js     ← OAuth scope validation
│   │   └── error-handler.js      ← JSON error responses for API routes
│   └── routes/
│       ├── oauth.js              ← OAuth2 server: app registration, authorize, token, revoke
│       ├── accounts.js           ← Account lookup, relationships, follow/unfollow, statuses
│       ├── statuses.js           ← Status CRUD, context/thread, favourite, boost, bookmark
│       ├── timelines.js          ← Home/public/hashtag timelines with account enrichment
│       ├── notifications.js      ← Notification listing with type filtering
│       ├── search.js             ← Account/status/hashtag search with remote resolution
│       ├── instance.js           ← Instance info, nodeinfo, custom emoji, preferences
│       ├── media.js              ← Media upload (stub)
│       └── stubs.js              ← 25+ stub endpoints preventing client errors
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
│   ├── federation-mgmt.js        ← Federation management (server blocks, moderation overview)
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
└── locales/{en,de,es,fr,...}.json ← i18n strings (15 locales)
```

## Data Flow

```
Outbound: Indiekit post → syndicator.js syndicate() → jf2ToAS2Activity() → ctx.sendActivity() → follower inboxes
          Broadcast (Update/Delete) → batch-broadcast.js → deduplicated shared inbox delivery
          Delivery failure → outbox-failure.js → 410: full cleanup | 404: strike system → eventual cleanup
Inbound:  Remote inbox POST → Fedify → inbox-listeners.js → ap_inbox_queue → inbox-handlers.js → MongoDB
          Reply forwarding: inbox-listeners.js checks if reply is to our post → ctx.forwardActivity() → follower inboxes
Reader:   Followed account posts → Create inbox → timeline-store → ap_timeline → reader UI
Explore:  Public Mastodon API → fetchMastodonTimeline() → mapMastodonToItem() → explore UI
Mastodon: Client (Phanpy/Elk/Moshidon) → /api/v1/* → ap_timeline + Fedify → JSON responses
          POST /api/v1/statuses → Micropub pipeline → content file → Eleventy rebuild → syndication → AP delivery

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
| `ap_blocked_servers` | Blocked server domains | `hostname` (unique) |
| `ap_key_freshness` | Remote actor key verification timestamps | `actorUrl` (unique), `lastVerifiedAt` |
| `ap_inbox_queue` | Persistent async inbox queue | `activityId`, `status`, `enqueuedAt` |
| `ap_tombstones` | Tombstone records for soft-deleted posts (FEP-4f05) | `url` (unique) |
| `ap_oauth_apps` | Mastodon API client registrations | `clientId` (unique), `clientSecret`, `redirectUris` |
| `ap_oauth_tokens` | OAuth2 authorization codes + access tokens | `code` (unique sparse), `accessToken` (unique sparse) |
| `ap_markers` | Read position markers (Mastodon API) | `userId`, `timeline` |

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

### 10. REMOVED: Endpoints `as:Endpoints` Type Stripping (Fixed in Fedify 2.1.0)

**Upstream issue:** [fedify#576](https://github.com/fedify-dev/fedify/issues/576) — FIXED in Fedify 2.1.0
**Previous workaround** in `federation-bridge.js` — **REMOVED**.
Fedify 2.1.0 now omits the invalid `"type": "as:Endpoints"` from serialized actor JSON. No workaround needed.

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

### 34. Mastodon Client API — Architecture (v3.0.0+)

The Mastodon Client API is mounted at `/` (domain root) via `Indiekit.addEndpoint()` to serve `/api/v1/*`, `/api/v2/*`, and `/oauth/*` endpoints that Mastodon-compatible clients expect.

**Key design decisions:**

- **Published-date pagination** — Status IDs are `encodeCursor(published)` (ms since epoch), NOT MongoDB ObjectIds. This ensures chronological timeline sort regardless of insertion order (backfilled posts get new ObjectIds but retain original published dates).
- **Status lookup** — `findTimelineItemById()` decodes cursor → published date → MongoDB lookup. Must try both `"2026-03-21T15:33:50.000Z"` (with ms) and `"2026-03-21T15:33:50Z"` (without) because stored dates vary.
- **Own-post detection** — `setLocalIdentity(publicationUrl, handle)` called at init. `serializeAccount()` compares `author.url === publicationUrl` to pass `isLocal: true`.
- **Account enrichment** — Phanpy never calls `/accounts/:id` for timeline authors. `enrichAccountStats()` batch-resolves unique authors via Fedify after serialization, cached in memory (500 entries, 1h TTL).
- **OAuth for native apps** — Android Custom Tabs block 302 redirects to custom URI schemes (`moshidon-android-auth://`, `fedilab://`). Use HTML page with JS `window.location` redirect instead.
- **OAuth token storage** — Auth code documents MUST NOT set `accessToken: null` — use field absence. MongoDB sparse unique indexes skip absent fields but enforce uniqueness on explicit `null`.
- **Route ordering** — `/accounts/relationships` and `/accounts/familiar_followers` MUST be defined BEFORE `/accounts/:id` in Express, otherwise `:id` matches "relationships" as a parameter.
- **Unsigned fallback** — `lookupWithSecurity()` tries authenticated (signed) GET first, falls back to unsigned if it fails. Some servers (tags.pub) reject signed GETs with 400.
- **Backfill** — `backfill-timeline.js` runs on startup, converts Micropub posts → `ap_timeline` format with content synthesis (bookmarks → "Bookmarked: URL"), hashtag extraction, and absolute URL resolution.

### 35. Mastodon API — Content Processing (v3.9.4+)

When creating posts via `POST /api/v1/statuses`:
- Content is provided to Micropub as `{ text, html }` with pre-linkified URLs (Micropub's markdown-it doesn't have `linkify: true`)
- `@user@domain` mentions are preserved as plain text — the AP syndicator resolves them via WebFinger for federation delivery
- Content warnings use `content-warning` field (not `summary`) to match the native reader and AP syndicator expectations
- No `ap_timeline` entry is created — the post appears in the timeline after the syndication round-trip (Eleventy rebuild → syndication webhook → AP delivery → inbox)
- A minimal Mastodon Status object is returned immediately to the client for UI feedback
- `mp-syndicate-to` is set to the AP syndicator UID (posts from Mastodon clients syndicate to fediverse only)

**Previous behavior (pre-3.9.4):** The handler created an `ap_timeline` entry immediately and used `processStatusContent()` to linkify URLs with hardcoded `/@username` patterns. This caused: (1) posts appearing in timeline before syndication, (2) broken mention URLs for non-Mastodon servers, (3) links lost in the Micropub content file.

### 36. Mastodon API — Status IDs and Threading (v3.12.0+)

**Status IDs are MongoDB ObjectId hex strings** (`_id.toString()`), NOT published-date cursors. This guarantees uniqueness — the previous cursor-based IDs (`encodeCursor(published)`) caused collisions when multiple posts shared the same second, resulting in `findTimelineItemById` returning wrong documents.

**Key behaviors:**
- `findTimelineItemById` does ObjectId-only lookup — no date parsing, no ambiguity
- `in_reply_to_id` and `in_reply_to_account_id` are batch-resolved via `resolve-reply-ids.js` using parent's `_id.toString()` and `remoteActorId(author.url)`
- Pagination uses ObjectId ordering (`{ _id: -1 }`) — ObjectIds have a 4-byte timestamp prefix so chronological sort works
- `encodeCursor`/`decodeCursor` removed from the API layer entirely

### 37. Mastodon API — Own Post Handling (v3.10.1+)

Own posts are added to `ap_timeline` by the AP syndicator after successful delivery. The syndicator:
- Builds content from JF2 properties via `buildTimelineContent()` (synthesizes content for likes/bookmarks/reposts)
- Linkifies `@mentions` using WebFinger-resolved profile URLs
- Stores resolved mentions with `actorUrl` for proper serialization

**Read-time enrichment by `serializeStatus`:**
- **Permalink** — appended for own posts (detected via `author.url === _localPublicationUrl`). Matches the `🔗` link in federated AS2 content. Done at read time so it survives timeline cleanup/backfill.
- **`@mention` links** — stored at write time on the `ap_timeline` entry with resolved `actorUrl` for deterministic Mastodon account IDs.

### 38. Mastodon API — Access Tokens (v3.12.4+)

**Access tokens do not expire.** They are valid until revoked, matching Mastodon's behavior. The previous 1-hour TTL caused Phanpy/Elk/Moshidon sessions to break silently. Refresh tokens expire after 90 days.

### 39. Mastodon API — Timeline Filtering (v3.12.5+)

**Reply filtering:** Public and hashtag timelines exclude replies (`inReplyTo: { $exists: false }`). Replies only appear in the context/thread view and the home timeline. This matches Mastodon/Pixelfed behavior.

**Home timeline reply visibility (DEFERRED):** Mastodon only shows replies in the home timeline when the user follows BOTH the replier AND the person being replied to. Our home timeline currently shows all replies from followed accounts regardless. Implementing this requires loading the following list and cross-checking each reply's target author — an expensive join per timeline load. Tracked as a future improvement.

**Keyword filters:** The filters CRUD (`GET/POST/PUT/DELETE /api/v2/filters`) stores filters in `ap_filters` with keywords in `ap_filter_keywords`. `apply-filters.js` loads active filters per context, compiles keyword regexes, and applies them after status serialization:
- `filterAction: "hide"` — status removed from response
- `filterAction: "warn"` — status kept with `filtered` array attached (Mastodon v2 format)

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
| | **Mastodon Client API (mounted at `/`)** | |
| `POST` | `/api/v1/apps` | Register OAuth client | No |
| `GET` | `/oauth/authorize` | Authorization page | IndieAuth |
| `POST` | `/oauth/authorize` | Process authorization | IndieAuth |
| `POST` | `/oauth/token` | Token exchange | No |
| `POST` | `/oauth/revoke` | Revoke token | No |
| `GET` | `/api/v1/accounts/verify_credentials` | Current user | Bearer |
| `GET` | `/api/v1/accounts/lookup` | Account lookup (with Fedify remote resolution) | Bearer |
| `GET` | `/api/v1/accounts/relationships` | Follow/block/mute state | Bearer |
| `GET` | `/api/v1/accounts/:id` | Account details (with remote AP collection counts) | Bearer |
| `GET` | `/api/v1/accounts/:id/statuses` | Account posts | Bearer |
| `POST` | `/api/v1/accounts/:id/follow,unfollow` | Follow/unfollow via Fedify | Bearer |
| `POST` | `/api/v1/accounts/:id/block,unblock,mute,unmute` | Moderation | Bearer |
| `GET` | `/api/v1/timelines/home,public,tag/:hashtag` | Timelines (published-date sort) | Bearer |
| `GET/POST` | `/api/v1/statuses` | Get/create status (via Micropub pipeline) | Bearer |
| `GET` | `/api/v1/statuses/:id/context` | Thread (ancestors + descendants) | Bearer |
| `POST` | `/api/v1/statuses/:id/favourite,reblog,bookmark` | Interactions via Fedify | Bearer |
| `GET` | `/api/v1/notifications` | Notifications with type filtering | Bearer |
| `GET` | `/api/v2/search` | Search with remote resolution | Bearer |
| `GET` | `/api/v1/domain_blocks` | Blocked server domains | Bearer |
| `GET` | `/api/v1/instance`, `/api/v2/instance` | Instance info | No |

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

## Standards Compliance

| FEP | Name | Status | Implementation |
|-----|------|--------|----------------|
| FEP-8b32 | Object Integrity Proofs | Full | Fedify signs all outbound activities with Ed25519 |
| FEP-521a | Multiple key pairs (Multikey) | Full | RSA for HTTP Signatures + Ed25519 for OIP |
| FEP-fe34 | Origin-based security | Full | `lookupWithSecurity()` in `lookup-helpers.js` |
| FEP-8fcf | Collection Sync | Outbound | `syncCollection: true` on `sendActivity()` — receiving side NOT implemented |
| FEP-5feb | Search indexing consent | Full | `indexable: true`, `discoverable: true` on actor in `federation-setup.js` |
| FEP-f1d5 | Enhanced NodeInfo | Full | `setNodeInfoDispatcher()` in `federation-setup.js` |
| FEP-4f05 | Soft delete / Tombstone | Full | `lib/storage/tombstones.js` + 410 in `contentNegotiationRoutes` |
| FEP-3b86 | Activity Intents | Full | WebFinger links + `authorize-interaction.js` intent routing |
| FEP-044f | Quote posts | Full | `quoteUrl` extraction + `ap-quote-embed.njk` rendering |
| FEP-c0e0 | Emoji reactions | Vocab only | Fedify provides `EmojiReact` class, no UI in plugin |
| FEP-5711 | Conversation threads | Vocab only | Fedify provides threading vocab |

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

## Startup Gate

This plugin uses `@rmdes/indiekit-startup-gate` to defer background tasks until the host signals readiness (after Eleventy build completes). This prevents resource contention during the build.

**Deferred:** `startBatchRefollow()`, `scheduleCleanup()`, `loadBlockedServersToRedis()`, `scheduleKeyRefresh()`, timeline backfill, `startInboxProcessor()`
**Immediate:** Routes, federation context, inbox HTTP handlers, `runSeparateMentionsMigration()`

See workspace CLAUDE.md for the full startup-gate pattern. Any new background tasks added to this plugin MUST be wrapped in `waitForReady()`. Inbox routes MUST remain immediate — they receive inbound federation traffic regardless of build state.

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

### 36. WORKAROUND: Direct Follow for tags.pub (v3.8.4+)

**File:** `lib/direct-follow.js`
**Upstream issue:** [tags.pub#10](https://github.com/social-web-foundation/tags.pub/issues/10) — OPEN
**Remove when:** tags.pub registers `https://w3id.org/identity/v1` as a known context in `activitypub-bot`'s `lib/activitystreams.js`, OR switches to a JSON-LD parser that handles unknown contexts gracefully.

**Problem:** Fedify 2.0 adds Linked Data Signatures (`RsaSignature2017`) to all outbound activities. The signature object embeds `"@context": "https://w3id.org/identity/v1"`, which gets hoisted into the top-level `@context` array. tags.pub's `activitypub-bot` uses the `activitystrea.ms` AS2 parser, which rejects any activity containing this context with `400 Invalid request body`. This affects ALL Fedify 2.0 servers, not just us.

**Workaround:** `lib/direct-follow.js` sends Follow/Undo(Follow) activities with a minimal JSON body (standard AS2 context only, no LD Signature, no Data Integrity Proof) signed with draft-cavage HTTP Signatures. The `DIRECT_FOLLOW_HOSTS` set controls which hostnames use this path (currently only `tags.pub`).

**Integration:** `followActor()` and `unfollowActor()` in `index.js` check `needsDirectFollow(actorUrl)` before sending. For matching hosts, they load the RSA private key from `ap_keys` via `_loadRsaPrivateKey()` and use `sendDirectFollow()`/`sendDirectUnfollow()` instead of Fedify's `ctx.sendActivity()`. All other servers use the normal Fedify pipeline unchanged.

**How to revert:** When the upstream fix lands:
1. Remove the `needsDirectFollow()` checks from `followActor()` and `unfollowActor()` in `index.js`
2. Remove the `_loadRsaPrivateKey()` method from the plugin class
3. Remove the `import` of `direct-follow.js` from `index.js`
4. Delete `lib/direct-follow.js`
5. Remove `tags.pub` from any test/documentation references to the workaround
6. Verify by following a tags.pub hashtag actor and confirming the normal Fedify path succeeds

**Additional tags.pub issues (not fixable on our side):**
- tags.pub does not send `Accept(Follow)` activities back to our inbox
- `@_followback@tags.pub` does not send Follow activities back despite accepting ours
- Both suggest tags.pub's outbound delivery is broken — zero inbound requests from `activitypub-bot` user-agent have been observed

### 37. Unverified Delete Activities (Fedify 2.1.0+)

`onUnverifiedActivity()` in `federation-setup.js` handles Delete activities from actors whose signing keys return 404/410. When an account is permanently deleted, the remote server sends a Delete activity but the actor's key endpoint is gone, so HTTP Signature verification fails. The handler checks `reason.type === "keyFetchError"` with status 404/410, cleans up the actor's data (followers, timeline items, notifications), and returns 202 Accepted.

### 38. FEP-8fcf Collection Synchronization — Outbound Only

We pass `syncCollection: true` to Fedify's `sendActivity()` for outbound activities, which attaches `Collection-Synchronization` headers with partial follower digests (XOR'd SHA-256 hashes). However, the **receiving side** (parsing inbound headers, digest comparison, reconciliation) is NOT implemented by Fedify or by us. Remote servers that send Collection-Synchronization headers to us will have them ignored. Full FEP-8fcf compliance would require a `/followers-sync` endpoint and a reconciliation scheduler.

## Form Handling Convention

Two form patterns are used in this plugin. New forms should follow the appropriate pattern.

### Pattern 1: Traditional POST (data mutation forms)

Used for: compose, profile editor, migration alias, notification mark-read/clear.

- Standard `<form method="POST" action="...">`
- CSRF via `<input type="hidden" name="_csrf" value="...">`
- Server processes, then redirects (PRG pattern)
- Success/error feedback via Indiekit's notification banner system
- Uses Indiekit form macros (`input`, `textarea`, `button`) where available

### Pattern 2: Alpine.js Fetch (in-page CRUD operations)

Used for: moderation add/remove keyword/server, tab management, federation actions.

- Alpine.js `@submit.prevent` or `@click` handlers
- CSRF via `X-CSRF-Token` header in `fetch()` call
- Inline error display with `x-show="error"` and `role="alert"`
- Optimistic UI with rollback on failure
- No page reload — DOM updates in place

### Rules

- Do NOT mix patterns on the same page (one pattern per form)
- All forms MUST include CSRF protection (hidden field OR header)
- Error feedback: Pattern 1 uses redirect + banner, Pattern 2 uses inline `x-show="error"`
- Success feedback: Pattern 1 uses redirect + banner, Pattern 2 uses inline DOM update or element removal

## CSS Conventions

The reader CSS (`assets/reader.css`) uses Indiekit's theme custom properties for automatic dark mode support:
- `--color-on-background` (not `--color-text`)
- `--color-on-offset` (not `--color-text-muted`)
- `--border-radius-small` (not `--border-radius`)
- `--color-red45`, `--color-green50`, etc. (not hardcoded hex)

Post types are differentiated by left border color: purple (notes), green (articles), yellow (boosts), primary (replies).
