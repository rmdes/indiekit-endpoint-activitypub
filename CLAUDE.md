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
├── lib/inbox-listeners.js        ← Handlers for Follow, Undo, Like, Announce, Create, Delete, etc.
├── lib/jf2-to-as2.js             ← JF2 → ActivityStreams conversion (plain JSON + Fedify vocab)
├── lib/kv-store.js               ← MongoDB-backed KvStore for Fedify
├── lib/activity-log.js           ← Activity logging to ap_activities
├── lib/timeline-store.js         ← Timeline item extraction + sanitization
├── lib/timeline-cleanup.js       ← Retention-based timeline pruning
├── lib/batch-refollow.js         ← Gradual re-follow for imported Mastodon accounts
├── lib/migration.js              ← CSV parsing + WebFinger resolution for Mastodon import
├── lib/csrf.js                   ← CSRF token generation/validation
├── lib/storage/
│   ├── timeline.js               ← Timeline CRUD with cursor pagination
│   ├── notifications.js          ← Notification CRUD with read/unread tracking
│   └── moderation.js             ← Mute/block storage
├── lib/controllers/              ← Express route handlers (admin UI)
│   ├── dashboard.js, reader.js, compose.js, profile.js, profile.remote.js
│   ├── followers.js, following.js, activities.js
│   ├── featured.js, featured-tags.js
│   ├── interactions.js, interactions-like.js, interactions-boost.js
│   ├── moderation.js, migrate.js, refollow.js
├── views/                        ← Nunjucks templates
│   ├── activitypub-*.njk         ← Page templates
│   ├── layouts/ap-reader.njk     ← Reader layout (NOT reader.njk — see gotcha below)
│   └── partials/                 ← Shared components
├── assets/
│   ├── reader.css                ← Reader UI styles
│   └── icon.svg                  ← Plugin icon
└── locales/en.json               ← i18n strings
```

## Data Flow

```
Outbound: Indiekit post → syndicator.syndicate() → jf2ToAS2Activity() → ctx.sendActivity() → follower inboxes
Inbound:  Remote inbox POST → Fedify → inbox-listeners.js → MongoDB collections → admin UI
Reader:   Followed account posts → Create inbox → timeline-store → ap_timeline → reader UI
```

## MongoDB Collections

| Collection | Purpose | Key fields |
|---|---|---|
| `ap_followers` | Accounts following us | `actorUrl` (unique), `inbox`, `sharedInbox`, `source` |
| `ap_following` | Accounts we follow | `actorUrl` (unique), `source`, `acceptedAt` |
| `ap_activities` | Activity log (TTL-indexed) | `direction`, `type`, `actorUrl`, `objectUrl`, `receivedAt` |
| `ap_keys` | Cryptographic key pairs | `type` ("rsa" or "ed25519"), key material |
| `ap_kv` | Fedify KvStore + job state | `_id` (key path), `value` |
| `ap_profile` | Actor profile (single doc) | `name`, `summary`, `icon`, `attachments`, `actorType` |
| `ap_featured` | Pinned posts | `postUrl`, `pinnedAt` |
| `ap_featured_tags` | Featured hashtags | `tag`, `addedAt` |
| `ap_timeline` | Reader timeline items | `uid` (unique), `published`, `author`, `content` |
| `ap_notifications` | Likes, boosts, follows, mentions | `uid` (unique), `type`, `read` |
| `ap_muted` | Muted actors/keywords | `url` or `keyword` |
| `ap_blocked` | Blocked actors | `url` |
| `ap_interactions` | Like/boost tracking per post | `objectUrl`, `type` |

## Critical Patterns and Gotchas

### 1. Express ↔ Fedify Bridge (CUSTOM — NOT @fedify/express)

We **cannot** use `@fedify/express`'s `integrateFederation()` because Indiekit mounts plugins at sub-paths. Express strips the mount prefix from `req.url`, breaking Fedify's URI template matching. Instead, `federation-bridge.js` uses `req.originalUrl` to build the full URL.

**If you see path-matching issues with Fedify, check that `req.originalUrl` is being used, not `req.url`.**

### 2. Content Negotiation Route — GET Only

The `contentNegotiationRoutes` router is mounted at `/` (root). It MUST only pass `GET`/`HEAD` requests to Fedify. Passing `POST`/`PUT`/`DELETE` would cause `fromExpressRequest()` to consume the body stream via `Readable.toWeb(req)`, breaking Express body-parsed routes downstream (admin forms, Micropub, etc.).

### 3. Skip Fedify for Admin Routes

In `routesPublic`, the middleware skips paths starting with `/admin`. Without this, Fedify would intercept admin UI requests and return 404/406 responses instead of letting Express serve the authenticated pages.

### 4. Use .objectId/.actorId — NOT .getObject()/.getActor() in Inbox Handlers

Fedify's `.getObject()` and `.getActor()` trigger HTTP fetches to remote servers. This fails silently or retries ~10 times when:
- Remote server has **Authorized Fetch** enabled (returns 401)
- Server is down or unreachable
- Object has been deleted

**Always prefer** `.objectId?.href` and `.actorId?.href` (zero network requests) for Like, Announce, Undo, and Delete handlers. Only use `.getObject()` / `.getActor()` when you need the full object, and **always wrap in try-catch**.

### 5. Accept(Follow) Matching — Don't Check Inner Object Type

Fedify often resolves the inner object of `Accept` to a `Person` (the Follow's target) rather than the `Follow` itself. The Accept handler matches against `ap_following` by actor URL instead of inspecting `inner instanceof Follow`.

### 6. Filter Inbound Likes/Announces to Our Content Only

Without filtering, the inbox logs every Like/Announce from every federated server — including reactions to other people's content that happens to flow through shared inboxes. Check `objectId.startsWith(publicationUrl)` before logging.

### 7. Nunjucks Template Name Collisions

Template names resolve across ALL registered plugin view directories. If two plugins have `views/layouts/reader.njk`, Nunjucks loads whichever it finds first (often wrong). The reader layout is named `ap-reader.njk` to avoid collision with `@rmdes/indiekit-endpoint-microsub`'s `reader.njk`.

**Never name a layout/template with a generic name that another plugin might use.**

### 8. Express 5 — No redirect("back")

Express 5 removed the `"back"` magic keyword from `response.redirect()`. It's treated as a literal URL, causing 404s at paths like `/admin/featured/back`. Always use explicit redirect paths.

### 9. Fedify Endpoints Type Bug (Workaround)

Fedify serializes `endpoints` with `"type": "as:Endpoints"` which is not a real ActivityStreams type. `sendFedifyResponse()` in `federation-bridge.js` strips this from actor JSON responses. Remove the workaround when [fedify#576](https://github.com/fedify-dev/fedify/issues/576) is fixed upstream.

### 10. Profile Links — Express qs Body Parser Key Mismatch

`express.urlencoded({ extended: true })` uses `qs` which strips `[]` from array field names. HTML fields named `link_name[]` arrive as `request.body.link_name` (not `request.body["link_name[]"]`). The profile controller reads `link_name` and `link_value`, NOT `link_name[]`.

### 11. Author Resolution Fallback Chain

`extractObjectData()` in `timeline-store.js` uses a multi-strategy fallback:
1. `object.getAttributedTo()` — async, may fail with Authorized Fetch
2. `options.actorFallback` — the activity's actor (passed from Create handler)
3. `object.attribution` / `object.attributedTo` — plain object properties
4. `object.attributionIds` — non-fetching URL array with username extraction from common patterns (`/@name`, `/users/name`)

Without this chain, many timeline items show "Unknown" as the author.

### 12. Username Extraction from Actor URLs

When extracting usernames from attribution IDs, handle multiple URL patterns:
- `/@username` (Mastodon)
- `/users/username` (Mastodon, Indiekit)
- `/ap/users/12345/` (numeric IDs on some platforms)

The regex was previously matching "users" instead of the actual username from `/users/NatalieDavis`.

### 13. Empty Boost Filtering

Lemmy/PieFed send Announce activities where the boosted object resolves to an activity ID instead of a Note/Article with actual content. Check `object.content || object.name` before storing to avoid empty cards in the timeline.

### 14. Temporal.Instant for Fedify Dates

Fedify uses `@js-temporal/polyfill` for dates. When setting `published` on Fedify objects, use `Temporal.Instant.from(isoString)`. When reading Fedify dates in inbox handlers, use `String(object.published)` to get ISO strings — NOT `new Date(object.published)` which causes `TypeError`.

### 15. LogTape — Configure Once Only

`@logtape/logtape`'s `configure()` can only be called once per process. The module-level `_logtapeConfigured` flag prevents duplicate configuration. If configure fails (e.g., another plugin already configured it), catch the error silently.

### 16. .authorize() Intentionally NOT Chained on Actor Dispatcher

Fedify's `.authorize()` triggers HTTP Signature verification on every GET to the actor endpoint. Servers requiring Authorized Fetch cause infinite loops: Fedify tries to fetch their key → they return 401 → Fedify retries → 500 errors. Re-enable when Fedify supports authenticated document loading for outgoing fetches.

### 17. Delivery Queue Must Be Started

`federation.startQueue()` MUST be called after setup. Without it, `ctx.sendActivity()` enqueues tasks but the message queue never processes them — activities are never delivered.

### 18. Shared Key Dispatcher for Shared Inbox

`inboxChain.setSharedKeyDispatcher()` tells Fedify to use our actor's key pair when verifying HTTP Signatures on the shared inbox. Without this, servers like hachyderm.io (which requires Authorized Fetch) have their signatures rejected.

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
| `GET` | `{mount}/admin/reader/notifications` | Notifications | Yes |
| `POST` | `{mount}/admin/reader/compose` | Compose reply | Yes |
| `POST` | `{mount}/admin/reader/like,unlike,boost,unboost` | Interactions | Yes |
| `POST` | `{mount}/admin/reader/follow,unfollow` | Follow/unfollow | Yes |
| `GET` | `{mount}/admin/reader/profile` | Remote profile view | Yes |
| `GET` | `{mount}/admin/reader/moderation` | Moderation dashboard | Yes |
| `POST` | `{mount}/admin/reader/mute,unmute,block,unblock` | Moderation actions | Yes |
| `GET` | `{mount}/admin/followers,following,activities` | Lists | Yes |
| `GET/POST` | `{mount}/admin/profile` | Actor profile editor | Yes |
| `GET/POST` | `{mount}/admin/featured` | Pinned posts | Yes |
| `GET/POST` | `{mount}/admin/tags` | Featured tags | Yes |
| `GET/POST` | `{mount}/admin/migrate` | Mastodon migration | Yes |
| `*` | `{mount}/admin/refollow/*` | Batch refollow control | Yes |
| `GET` | `/*` (root) | Content negotiation (AP clients only) | No |

## Dependencies

| Package | Purpose |
|---|---|
| `@fedify/fedify` | ActivityPub federation framework |
| `@fedify/express` | Express integration utilities (types only — bridge is custom) |
| `@fedify/redis` | Redis message queue for delivery |
| `@js-temporal/polyfill` | Temporal API for Fedify date handling |
| `ioredis` | Redis client |
| `sanitize-html` | XSS prevention for timeline/notification content |
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
  timelineRetention: 1000,          // Max timeline items (0 = unlimited)
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
