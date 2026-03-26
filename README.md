# @rmdes/indiekit-endpoint-activitypub

ActivityPub federation endpoint for [Indiekit](https://getindiekit.com), built on [Fedify](https://fedify.dev) 2.1. Makes your IndieWeb site a full fediverse actor — discoverable, followable, and interactive from Mastodon, Misskey, Pixelfed, and any ActivityPub-compatible platform. Includes a Mastodon-compatible Client API so you can use Phanpy, Elk, Moshidon, Fedilab, and other Mastodon clients with your own AP instance.

## Features

**Federation**
- Full ActivityPub actor with WebFinger, NodeInfo, HTTP Signatures, and Object Integrity Proofs (Ed25519)
- Outbox syndication — posts created via Micropub are automatically delivered to followers
- Inbox processing — receives follows, likes, boosts, replies, mentions, deletes, and account moves
- Content negotiation — ActivityPub clients requesting your site get JSON-LD; browsers get HTML
- Reply delivery — replies are addressed to and delivered directly to the original post's author
- Shared inbox support with collection sync (FEP-8fcf)
- Configurable actor type (Person, Service, Organization, Group)
- Manual follow approval — review and accept/reject follow requests before they take effect
- Direct messages — private conversations stored separately from the public timeline

**Federation Resilience** *(v2.14.0+)*
- Async inbox queue — inbound activities are persisted to MongoDB before processing, ensuring no data loss on crashes
- Server blocking — block entire remote servers by domain, rejecting all inbound activities from blocked instances
- Key freshness tracking — tracks when remote actor keys were last verified, skipping redundant re-fetches
- Redis-cached actor lookups — caches actor resolution results to reduce network round-trips
- Delivery strike tracking on `ap_followers` — counts consecutive delivery failures per follower
- FEP-fe34 security — verifies `proof.created` timestamps to reject replayed activities

**Outbox Failure Handling** *(v2.15.0+, inspired by [Hollo](https://github.com/fedify-dev/hollo))*
- **410 Gone** — immediate full cleanup: removes the follower, their timeline items, and their notifications
- **404 Not Found** — strike system: 3 consecutive failures over 7+ days triggers the same full cleanup
- Strike auto-reset — when an actor sends us any activity, their delivery failure count resets to zero
- Prevents orphaned data from accumulating over time while tolerating temporary server outages

**Reply Intelligence** *(v2.15.0+, inspired by [Hollo](https://github.com/fedify-dev/hollo))*
- Recursive reply chain fetching — when a reply arrives, fetches parent posts up to 5 levels deep for thread context
- Ancestor posts stored with `isContext: true` flag for thread view without cluttering the main timeline
- Reply forwarding to followers — when someone replies to our posts, the reply is forwarded to our followers so they see the full conversation
- Write-time visibility classification — computes `public`/`unlisted`/`private`/`direct` from `to`/`cc` fields at ingest time

**Reader**
- Timeline view showing posts from followed accounts with tab filtering (notes, articles, replies, boosts, media)
- Explore view — browse public timelines from any Mastodon-compatible instance
- Cross-instance hashtag search — search a hashtag across multiple fediverse instances
- Tag timeline — view and follow/unfollow specific hashtags
- Post detail view with threaded context
- Quote post embeds — quoted posts render as inline cards with author, content, and timestamp (FEP-044f, Misskey, Fedibird formats)
- Link preview cards via Open Graph metadata unfurling
- Notifications for likes, boosts, follows, mentions, and replies
- Compose form with dual-path posting (quick AP reply or Micropub blog post)
- Native interactions (like, boost, reply, follow/unfollow from the reader)
- Remote actor profile pages
- Content warnings and sensitive content handling
- Media display (images, video, audio)
- Infinite scroll with IntersectionObserver-based auto-loading
- New post banner — polls for new items and offers one-click loading
- Read tracking — marks posts as read on scroll, with unread filter toggle
- Popular accounts autocomplete in the fediverse lookup bar
- Configurable timeline retention

**Moderation**
- Mute actors or keywords
- Block actors (also removes from followers)
- Block entire servers by domain
- Report remote actors to their home instance (Flag activity)
- All moderation actions available from the reader UI

**Mastodon Migration**
- Import following/followers lists from Mastodon CSV exports
- Set `alsoKnownAs` alias for account Move verification
- Batch re-follow processor — gradually sends Follow activities to imported accounts
- Progress tracking with pause/resume controls

**Public Profile**
- Standalone profile page at the actor URL (HTML fallback for browsers)
- Shows avatar, bio, profile fields, follower/following/post counts, and follow prompt
- Dark mode support via system preference

**Debug Dashboard**
- Optional [Fedify Debugger](https://github.com/fedify-dev/debugger) integration
- Password-protected dashboard at `{mountPath}/__debug__/`
- OpenTelemetry tracing for federation activity
- Real-time activity inspection

**Mastodon Client API** *(v3.0.0+)*
- Full Mastodon REST API compatibility — use Phanpy, Elk, Moshidon, Fedilab, or any Mastodon-compatible client
- OAuth2 with PKCE (S256) — app registration, authorization, token exchange
- HTML+JS redirect for native Android apps (Chrome Custom Tabs block 302 to custom URI schemes)
- Home, public, and hashtag timelines with chronological published-date pagination
- Status creation via Micropub pipeline — posts flow through Indiekit → content file → AP syndication
- URL auto-linkification and @mention extraction in posted content
- Thread context (ancestors + descendants)
- Remote profile resolution via Fedify WebFinger with follower/following/post counts from AP collections
- Account stats enrichment — cached account data applied immediately; uncached accounts resolved in background
- Favourite, boost, bookmark interactions federated via Fedify AP activities
- Notifications with type filtering
- Search across accounts, statuses, and hashtags with remote resolution
- Domain blocks API
- Timeline backfill from posts collection on startup (bookmarks, likes, reposts get synthesized content)
- In-memory account stats cache (500 entries, 1h TTL) for performance
- OAuth2 scope enforcement — read/write scope validation on all API routes
- Rate limiting — configurable limits on API, auth, and app registration endpoints
- Access token expiry (1 hour) with refresh token rotation (90 days)
- PKCE (S256) and CSRF protection on authorization flow

**Admin UI**
- Dashboard with follower/following counts and recent activity
- Profile editor (name, bio, avatar, header, profile links with rel="me" verification)
- Pinned posts (featured collection)
- Featured tags (hashtag collection)
- Activity log (inbound/outbound)
- Follower and following lists with source tracking
- Federation management page with moderation overview (blocked servers, blocked accounts, muted)

**Standards Compliance**
- FEP-5feb: Search Indexing Consent — actor advertises `indexable` and `discoverable` properties
- FEP-f1d5/0151: Enhanced NodeInfo 2.1 — rich metadata including software repository, node name, staff accounts
- FEP-4f05: Soft Delete with Tombstone — deleted posts return 410 with Tombstone JSON-LD including `formerType` and timestamps
- FEP-3b86: Activity Intents — WebFinger links for Follow, Create, Like, Announce intents with authorize_interaction routing
- FEP-8fcf: Collection Synchronization — outbound follower digest headers via Fedify `syncCollection`
- FEP-044f: Quote Posts — rendered as embedded cards (via Fedify's `quoteUrl` support)

## Requirements

- [Indiekit](https://getindiekit.com) v1.0.0-beta.25+
- [Fedify](https://fedify.dev) 2.1+ (bundled as dependency)
- Node.js >= 22
- MongoDB (used by Indiekit)
- Redis (recommended for production delivery queue; in-process queue available for development)

## Installation

```bash
npm install @rmdes/indiekit-endpoint-activitypub
```

## Configuration

Add the plugin to your Indiekit config:

```javascript
// indiekit.config.js
export default {
  plugins: [
    "@rmdes/indiekit-endpoint-activitypub",
  ],
  "@rmdes/indiekit-endpoint-activitypub": {
    mountPath: "/activitypub",
    actor: {
      handle: "yourname",
      name: "Your Name",
      summary: "A short bio",
      icon: "https://example.com/avatar.jpg",
    },
  },
};
```

### All Options

| Option | Type | Default | Description |
|---|---|---|---|
| `mountPath` | string | `"/activitypub"` | URL prefix for all plugin routes |
| `actor.handle` | string | `"rick"` | Fediverse username (e.g. `@handle@yourdomain.com`) |
| `actor.name` | string | `""` | Display name (used to seed profile on first run) |
| `actor.summary` | string | `""` | Bio text (used to seed profile on first run) |
| `actor.icon` | string | `""` | Avatar URL (used to seed profile on first run) |
| `checked` | boolean | `true` | Whether the syndicator is checked by default in the post editor |
| `alsoKnownAs` | string | `""` | Mastodon migration alias URL |
| `activityRetentionDays` | number | `90` | Days to keep activity log entries (0 = forever) |
| `storeRawActivities` | boolean | `false` | Store full raw JSON of inbound activities |
| `redisUrl` | string | `""` | Redis connection URL for delivery queue |
| `parallelWorkers` | number | `5` | Number of parallel delivery workers (requires Redis) |
| `actorType` | string | `"Person"` | Actor type: `Person`, `Service`, `Organization`, or `Group` |
| `logLevel` | string | `"warning"` | Fedify log level: `"debug"`, `"info"`, `"warning"`, `"error"`, `"fatal"` |
| `timelineRetention` | number | `1000` | Maximum timeline items to keep (0 = unlimited) |
| `notificationRetentionDays` | number | `30` | Days to keep notifications (0 = forever) |
| `debugDashboard` | boolean | `false` | Enable Fedify debug dashboard at `{mountPath}/__debug__/` |
| `debugPassword` | string | `""` | Password for the debug dashboard (required if dashboard enabled) |

### Redis (Recommended for Production)

Without Redis, the plugin uses an in-process message queue. This works for development but won't survive restarts and has limited throughput.

```javascript
"@rmdes/indiekit-endpoint-activitypub": {
  redisUrl: "redis://localhost:6379",
  parallelWorkers: 5,
},
```

### Nginx Configuration (Reverse Proxy)

If you serve a static site alongside Indiekit (e.g. with Eleventy), you need nginx rules to route ActivityPub requests to Indiekit while serving HTML to browsers:

```nginx
# ActivityPub content negotiation — detect AP clients
map $http_accept $is_activitypub {
    default 0;
    "~*application/activity\+json" 1;
    "~*application/ld\+json" 1;
}

# Proxy /activitypub to Indiekit
location /activitypub {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}

# Default: static site, but AP clients get proxied
location / {
    if ($is_activitypub) {
        proxy_pass http://127.0.0.1:8080;
    }
    try_files $uri $uri/ $uri.html =404;
}
```

## How It Works

### Syndication (Outbound)

When you create a post via Micropub, Indiekit's syndication system calls this plugin's syndicator. The plugin:

1. Converts the JF2 post properties to an ActivityStreams 2.0 `Create(Note)` or `Create(Article)` activity
2. For replies, resolves the original post's author to include them in CC and deliver directly to their inbox
3. Sends the activity to all followers via shared inboxes using Fedify's delivery queue
4. Appends a permalink to the content so fediverse clients link back to your canonical post

### Inbox Processing (Inbound)

When remote servers send activities to your inbox:

- **Follow** → Auto-accepted, stored in `ap_followers`, notification created
- **Undo(Follow)** → Removed from `ap_followers`
- **Like** → Logged in activity log, notification created (only for reactions to your own posts)
- **Announce (Boost)** → Logged + notification (your content) or stored in timeline (followed account)
- **Create (Note/Article)** → Stored in timeline if from a followed account; notification if it's a reply or mention
- **Update** → Updates timeline item content or refreshes follower profile data
- **Delete** → Removes from activity log and timeline
- **Move** → Updates follower's actor URL
- **Accept(Follow)** → Marks our follow as accepted
- **Reject(Follow)** → Marks our follow as rejected
- **Block** → Removes actor from our followers
- **Flag** → Outbound report sent to remote actor's instance

### Content Negotiation

The plugin mounts a root-level router that intercepts requests from ActivityPub clients (detected by `Accept: application/activity+json` or `application/ld+json`):

- Root URL (`/`) → Redirects to the Fedify actor document
- Post URLs → Looks up the post in MongoDB, converts to AS2 JSON
- NodeInfo (`/nodeinfo/2.1`) → Delegated to Fedify

Regular browser requests pass through unmodified.

### Mastodon Migration

The plugin supports migrating from a Mastodon account:

1. **Set alias** — Configure `alsoKnownAs` with your old Mastodon profile URL. This is verified by Mastodon before allowing a Move.
2. **Import social graph** — Upload Mastodon's `following_accounts.csv` and `followers.csv` exports. Following entries are resolved via WebFinger and stored locally.
3. **Trigger Move** — From Mastodon's settings, initiate a Move to `@handle@yourdomain.com`. Mastodon notifies your followers, and compatible servers auto-refollow.
4. **Batch re-follow** — The plugin gradually sends Follow activities to all imported accounts (10 per batch, 30s between batches) so remote servers start delivering content to your inbox.

## Verification

After deployment, verify federation is working:

```bash
# WebFinger discovery
curl -s "https://yourdomain.com/.well-known/webfinger?resource=acct:handle@yourdomain.com" | jq .

# Actor document
curl -s -H "Accept: application/activity+json" "https://yourdomain.com/" | jq .

# NodeInfo
curl -s "https://yourdomain.com/nodeinfo/2.1" | jq .
```

Then search for `@handle@yourdomain.com` from any Mastodon instance — your profile should appear.

## Admin UI Pages

All admin pages are behind IndieAuth authentication:

| Page | Path | Description |
|---|---|---|
| Dashboard | `/activitypub` | Overview with follower/following counts, recent activity |
| Reader | `/activitypub/admin/reader` | Timeline from followed accounts (tabbed: notes, articles, replies, boosts, media) |
| Explore | `/activitypub/admin/reader/explore` | Browse public timelines from Mastodon-compatible instances |
| Hashtag Explore | `/activitypub/admin/reader/explore/hashtag` | Search a hashtag across multiple fediverse instances |
| Tag Timeline | `/activitypub/admin/reader/tag?tag=name` | Posts filtered by a specific hashtag, with follow/unfollow |
| Post Detail | `/activitypub/admin/reader/post?url=...` | Single post view with quote embeds and link previews |
| Notifications | `/activitypub/admin/reader/notifications` | Likes, boosts, follows, mentions, replies |
| Compose | `/activitypub/admin/reader/compose` | Reply composer (quick AP or Micropub) |
| Moderation | `/activitypub/admin/reader/moderation` | Muted/blocked accounts and keywords |
| Profile | `/activitypub/admin/profile` | Edit actor display name, bio, avatar, links |
| Followers | `/activitypub/admin/followers` | List of accounts following you |
| Following | `/activitypub/admin/following` | List of accounts you follow |
| Activity Log | `/activitypub/admin/activities` | Inbound/outbound activity history |
| Pinned Posts | `/activitypub/admin/featured` | Pin/unpin posts to your featured collection |
| Featured Tags | `/activitypub/admin/tags` | Add/remove featured hashtags |
| Migration | `/activitypub/admin/migrate` | Mastodon import wizard |
| Public Profile | `/activitypub/users/{handle}` | Public-facing profile page (no auth) |
| Debug Dashboard | `/activitypub/__debug__/` | Fedify debugger (password-protected, if enabled) |

## MongoDB Collections

The plugin creates these collections automatically:

| Collection | Description |
|---|---|
| `ap_followers` | Accounts following your actor (includes delivery failure strike tracking) |
| `ap_following` | Accounts you follow |
| `ap_activities` | Activity log with automatic TTL cleanup |
| `ap_keys` | RSA and Ed25519 key pairs for HTTP Signatures |
| `ap_kv` | Fedify key-value store and batch job state |
| `ap_profile` | Actor profile (single document) |
| `ap_featured` | Pinned/featured posts |
| `ap_featured_tags` | Featured hashtags |
| `ap_timeline` | Reader timeline items (includes `visibility` and `isContext` fields) |
| `ap_notifications` | Interaction notifications |
| `ap_muted` | Muted actors and keywords |
| `ap_blocked` | Blocked actors |
| `ap_interactions` | Per-post like/boost tracking |
| `ap_messages` | Direct messages / private conversations |
| `ap_followed_tags` | Hashtags you follow for timeline filtering |
| `ap_explore_tabs` | Saved Mastodon instances for the explore view |
| `ap_reports` | Outbound reports (Flag activities) sent to remote instances |
| `ap_pending_follows` | Follow requests awaiting manual approval |
| `ap_blocked_servers` | Blocked server domains (instance-level blocks) |
| `ap_key_freshness` | Tracks when remote actor keys were last verified |
| `ap_inbox_queue` | Persistent async inbox processing queue |
| `ap_tombstones` | Tombstone records for soft-deleted posts (FEP-4f05) |
| `ap_oauth_apps` | Mastodon API client app registrations |
| `ap_oauth_tokens` | OAuth2 authorization codes and access tokens |
| `ap_markers` | Read position markers for Mastodon API clients |

## Supported Post Types

The JF2-to-ActivityStreams converter handles these Indiekit post types:

| Post Type | ActivityStreams |
|---|---|
| note, reply, bookmark, jam, rsvp, checkin | `Create(Note)` |
| article | `Create(Article)` |
| like | `Like` |
| repost | `Announce` |
| photo, video, audio | Attachments on Note/Article |

Categories are converted to `Hashtag` tags. Bookmarks include a bookmark emoji and link.

## Fedify Workarounds and Implementation Notes

This plugin uses [Fedify](https://fedify.dev) 2.1 but carries several workarounds for issues in Fedify or its Express integration. These are documented here so they can be revisited when Fedify upgrades.

### Custom Express Bridge (instead of `@fedify/express`)

**File:** `lib/federation-bridge.js`
**Upstream issue:** `@fedify/express` uses `req.url` ([source](https://github.com/fedify-dev/fedify/blob/main/packages/express/src/index.ts), line 73), not `req.originalUrl`.

Indiekit plugins mount at a sub-path (e.g. `/activitypub`). Express strips the mount prefix from `req.url`, so Fedify's URI template matching breaks — WebFinger, actor endpoints, and inbox all return 404. The custom bridge uses `req.originalUrl` to preserve the full path.

The bridge also reconstructs POST bodies that Express's body parser has already consumed (`req.readable === false`). Without this, Fedify handlers like the `@fedify/debugger` login form receive empty bodies.

**Revisit when:** `@fedify/express` switches to `req.originalUrl`, or provides an option to pass a custom URL builder.

### JSON-LD Attachment Array Compaction

**File:** `lib/federation-bridge.js` (in `sendFedifyResponse()`)
**Upstream issue:** JSON-LD compaction collapses single-element arrays to plain objects.

Mastodon's `update_account_fields` checks `attachment.is_a?(Array)` and silently skips profile links (PropertyValues) when `attachment` is a plain object instead of an array. The bridge intercepts actor JSON-LD responses and forces `attachment` to always be an array.

**Revisit when:** Fedify adds an option to preserve arrays during JSON-LD serialization, or Mastodon fixes their array check.

### Endpoints `as:Endpoints` Type Stripping — REMOVED

**Upstream issue:** [fedify#576](https://github.com/fedify-dev/fedify/issues/576) — FIXED in Fedify 2.1.0

This workaround has been removed. Fedify 2.1.0 now omits the invalid `"type": "as:Endpoints"` from serialized actor JSON.

### PropertyValue Attachment Type (Known Issue)

**Upstream issue:** [fedify#629](https://github.com/fedify-dev/fedify/issues/629) — OPEN

Fedify serializes `PropertyValue` attachments (used by Mastodon for profile metadata fields) with `"type": "PropertyValue"`, a schema.org type that is not a valid AS2 Object or Link. browser.pub rejects `/attachment` as invalid. However, every Mastodon-compatible server emits `PropertyValue` — removing it would break profile field display across the fediverse.

**No workaround applied.** This is a de facto fediverse standard despite not being in the AS2 vocabulary.

### `.authorize()` Not Chained on Actor Dispatcher

**File:** `lib/federation-setup.js` (line ~254)
**Upstream issue:** No authenticated document loading for outgoing key fetches during signature verification.

Fedify's `.authorize()` predicate triggers HTTP Signature verification on every GET to the actor endpoint. When a remote server that requires Authorized Fetch (e.g. kobolds.online) requests our actor, Fedify tries to fetch *their* public key to verify the signature. Those servers return 401 on unsigned GETs, causing uncaught `FetchError` and 500 responses.

This means we do **not** enforce Authorized Fetch on our actor endpoint. Any server can read our actor document without signing the request.

**Revisit when:** Fedify supports using the instance actor's keys for outgoing document fetches during signature verification (i.e. authenticated document loading in the verification path, not just in inbox handlers).

### `importSpkiPem()` / `importPkcs8Pem()` — Local PEM Import

**File:** `lib/federation-setup.js` (lines ~784–816)
**Upstream change:** Fedify 1.x exported `importSpki()` for loading PEM public keys. This was removed in Fedify 2.0.

The plugin carries local `importSpkiPem()` and `importPkcs8Pem()` functions that use the Web Crypto API directly (`crypto.subtle.importKey`) to load legacy RSA key pairs stored in MongoDB from the Fedify 1.x era. New key pairs are generated using Fedify 2.0's `generateCryptoKeyPair()` and stored as JWK, so these functions only matter for existing installations that migrated from Fedify 1.x.

**Revisit when:** All existing installations have been migrated to JWK-stored keys, or Fedify re-exports a PEM import utility.

### Authenticated Document Loader for Inbox Handlers

**File:** `lib/inbox-listeners.js`
**Upstream behavior:** Fedify's personal inbox handlers do not automatically use authenticated (signed) HTTP fetches.

All `.getActor()`, `.getObject()`, and `.getTarget()` calls in inbox handlers must explicitly pass an authenticated `DocumentLoader` obtained via `ctx.getDocumentLoader({ identifier: handle })`. Without this, fetches to Authorized Fetch (Secure Mode) servers like hachyderm.io fail with 401, causing timeline items to show "Unknown" authors and missing content.

This is not a bug — Fedify requires explicit opt-in for signed fetches. But it's a pattern that every inbox handler must follow, and forgetting it silently degrades functionality.

**Revisit when:** Fedify provides an option to default to authenticated fetches in inbox handler context, or adds a middleware layer that handles this automatically.

## Known Limitations

- **No automated tests** — Manual testing against real fediverse servers
- **Single actor** — One fediverse identity per Indiekit instance
- **No Authorized Fetch enforcement** — `.authorize()` disabled on actor dispatcher (see workarounds above)
- **No image upload in reader** — Compose form is text-only
- **In-process queue without Redis** — Activities may be lost on restart

## Acknowledgements

This plugin builds on the excellent [Fedify](https://fedify.dev) framework by [Hong Minhee](https://github.com/dahlia). Fedify provides the core ActivityPub federation layer — HTTP Signatures, content negotiation, message queues, and the vocabulary types that make all of this possible.

Several federation patterns in this plugin were inspired by studying other open-source ActivityPub implementations:

- **[Hollo](https://github.com/fedify-dev/hollo)** (by the Fedify author) — A single-user Fedify-based ActivityPub server that served as the primary reference implementation. The outbox permanent failure handling (410 cleanup and 404 strike system), recursive reply chain fetching, reply forwarding to followers, and write-time visibility classification in v2.15.0 are all adapted from Hollo's patterns for a MongoDB/single-user context.

- **[Wafrn](https://github.com/gabboman/wafrn)** — A federated social network whose ActivityPub implementation informed the operational resilience patterns added in v2.14.0. Server blocking, key freshness tracking, async inbox processing with persistent queues, and the general approach to federation hardening were inspired by studying Wafrn's production codebase.

## License

MIT

## Author

[Ricardo Mendes](https://rmendes.net) ([@rick@rmendes.net](https://rmendes.net))
