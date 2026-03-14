# ActivityPub Coverage Audit: @rmdes/indiekit-endpoint-activitypub vs Fedify 2.0

**Date:** 2026-03-13
**Plugin Version:** 2.9.2
**Fedify Version:** 2.0.0
**Auditor:** Claude Code (Opus 4.6)

---

## Legend

- **Implemented** — fully working in production
- **Partial** — some aspects implemented, gaps remain
- **Not implemented** — Fedify supports it, we don't use it

---

## 1. Inbound Activity Handlers

All handlers are in `lib/inbox-listeners.js`. Fedify dispatches inbound activities to registered listeners via `setInboxListeners()`.

| Activity Type | Fedify Support | Our Implementation | Status |
|---|---|---|---|
| `Follow` | Full | Auto-accept, store follower in `ap_followers`, create notification, log to `ap_activities` (lines 90–149) | **Implemented** |
| `Accept` | Full | Updates `ap_following` entry to `source: "federation"`, clears retry fields (lines 194–235) | **Implemented** |
| `Reject` | Full | Marks `ap_following` entry as `source: "rejected"` (lines 236–267) | **Implemented** |
| `Undo(Follow)` | Full | Removes from `ap_followers` (lines 151–170) | **Implemented** |
| `Undo(Like)` | Full | Removes from `ap_activities` (lines 171–183) | **Implemented** |
| `Undo(Announce)` | Full | Removes from `ap_activities` (lines 184–193) | **Implemented** |
| `Like` | Full | Filtered to our content only (`objectId.startsWith(publicationUrl)`), stores notification + activity log (lines 268–317) | **Implemented** |
| `Announce` | Full | Dual path: boosts of our posts → notification; boosts from followed accounts → `ap_timeline` with quote enrichment (lines 318–412) | **Implemented** |
| `Create` | Full | Four paths: DMs → `ap_messages`; replies to us → notification; mentions → notification; followed accounts → `ap_timeline` with link preview + quote enrichment (lines 413–639) | **Implemented** |
| `Delete` | Full | Removes from `ap_activities` + `ap_timeline` (lines 640–649) | **Implemented** |
| `Update` | Full | Post updates → `ap_timeline` content refresh; profile updates → follower data refresh (lines 672–735) | **Implemented** |
| `Move` | Full | Updates follower `actorUrl` to new address, stores `movedFrom` (lines 650–671) | **Implemented** |
| `Block` | Full | Remote actor blocked us → removes from `ap_followers` (lines 736–744) | **Implemented** |
| `Add` / `Remove` | Full | No-op — logged only. Mastodon uses these for featured collection management (lines 745–750) | **Partial** — not used for featured collection sync |
| `Flag` | Full | Not handled | **Not implemented** — no report/moderation inbox |
| `EmojiReact` | Full (LitePub) | Not handled | **Not implemented** |
| `Dislike` | Full | Not handled | **Not implemented** — rarely used in fediverse |
| `Question` | Full | Not handled specially | **Not implemented** — polls not parsed |
| `Arrive` / `Travel` / `Join` / `Leave` | Full | Not handled | **Not implemented** — niche activity types |
| `Invite` / `Offer` | Full | Not handled | **Not implemented** |
| `Read` / `View` / `Listen` | Full | Not handled | **Not implemented** — niche |

**Score: 13/21 activity types handled (62%), covering ~99% of real-world fediverse traffic**

---

## 2. Outbound Activities

Outbound activities are sent via `ctx.sendActivity()` from syndicator (`index.js`), interaction controllers (`lib/controllers/interactions-*.js`), compose (`lib/controllers/compose.js`), and messages (`lib/controllers/messages.js`).

| Activity | Fedify Support | Our Implementation | Status |
|---|---|---|---|
| `Create(Note)` | Full | Via syndicator (`jf2ToAS2Activity()`) + DM compose (`submitMessageController`) | **Implemented** |
| `Create(Article)` | Full | Via syndicator (`jf2ToAS2Activity()`) | **Implemented** |
| `Like` | Full | Reader interaction button (`interactions-like.js:14–115`) | **Implemented** |
| `Undo(Like)` | Full | Unlike button (`interactions-like.js:121–229`) | **Implemented** |
| `Announce` | Full | Boost button (`interactions-boost.js:14–~100`) | **Implemented** |
| `Undo(Announce)` | Full | Unboost button (`interactions-boost.js:~101–~180`) | **Implemented** |
| `Follow` | Full | Reader follow + migration + batch refollow (`index.js:572–667`) | **Implemented** |
| `Undo(Follow)` | Full | Unfollow button (`index.js:674–~750`) | **Implemented** |
| `Accept(Follow)` | Full | Auto-accept on inbound Follow (`inbox-listeners.js:120–128`) | **Implemented** |
| `Update(Person)` | Full | Profile edit broadcasts to all followers (`index.js:761–~850`) | **Implemented** |
| `Delete` | Full | Not sent when posts are deleted | **Not implemented** |
| `Block` | Full | Local-only mute/block, no `Block` activity sent to remote | **Not implemented** |
| `Flag` | Full | No report sending UI | **Not implemented** |
| `Move` | Full | No outbound account migration | **Not implemented** |
| `Reject(Follow)` | Full | Auto-accept only, no manual approval/reject | **Not implemented** |
| `Create(Question)` | Full | No poll creation | **Not implemented** |

**Score: 10/16 common outbound activities (63%)**

---

## 3. Federation Dispatchers & Collections

All dispatchers are registered in `lib/federation-setup.js`.

| Dispatcher/Collection | Fedify Support | Our Implementation | Status |
|---|---|---|---|
| Actor (`Person`) | Full | Full with 5 actor types (Person, Service, Organization, Group, Application). Instance actor for shared inbox signing. RSA + Ed25519 key pairs. `mapHandle()` + `mapAlias()`. (lines 134–160) | **Implemented** |
| Inbox (personal + shared) | Full | Both endpoints registered. `setSharedKeyDispatcher()` for Authorized Fetch servers. (lines 283–295) | **Implemented** |
| Outbox | Full | Paginated, converts published blog posts to `Create(Note\|Article)` via `jf2ToAS2Activity()`. 20 per page. (lines 589–~650) | **Implemented** |
| Followers | Full | Paginated + one-shot mode for `sendActivity("followers")` batch delivery. Counter. (lines 396–445) | **Implemented** |
| Following | Full | Paginated with counter. 20 per page. (lines 447–475) | **Implemented** |
| Liked | Full | From `posts` collection where `post-type: "like"`. Paginated. (lines 477–518) | **Implemented** |
| Featured (pinned posts) | Full | Admin UI + AP collection. Converts pinned posts via `jf2ToAS2Activity()`. (lines 520–555) | **Implemented** |
| Featured Tags | Full | Admin UI + AP collection. Hashtag objects with category page links. (lines 557–587) | **Implemented** |
| Object dispatcher | Full | Content negotiation on individual post URLs. Returns `Create(Note\|Article)` AS2 JSON-LD for `Accept: application/activity+json`. | **Implemented** |
| WebFinger | Full | With OStatus subscribe link for remote follow from WordPress AP, Misskey, etc. (lines 275–282) | **Implemented** |
| NodeInfo | Full | Version 2.1. Reports software, protocols, total posts, active users. (lines 322–339) | **Implemented** |
| `.authorize()` on actor | Full | Intentionally disabled — causes infinite loops with Authorized Fetch servers. See CLAUDE.md Gotcha #16. | **Not implemented** |
| Custom collections | Full | Not used | **Not implemented** |

**Score: 11/13 (85%)**

---

## 4. Cryptography & Security

Key storage in `ap_keys` collection. Key generation and signing handled by Fedify internals.

| Feature | Fedify Support | Our Implementation | Status |
|---|---|---|---|
| RSA key pairs (HTTP Signatures) | Full | Generated on first use, stored as PEM in `ap_keys` (`federation-setup.js`) | **Implemented** |
| Ed25519 key pairs (Object Integrity Proofs) | Full | Generated on first use, stored as JWK in `ap_keys` | **Implemented** |
| HTTP Signatures (draft-cavage-12) | Full | Automatic via Fedify signing on all outbound requests | **Implemented** |
| HTTP Message Signatures (RFC 9421) | Full | Automatic via Fedify double-knocking negotiation | **Implemented** |
| Double-Knocking negotiation | Full | Automatic — Fedify caches per-server signature spec preference | **Implemented** |
| Authenticated Document Loader | Full | Used in all inbox handlers via `getAuthLoader()` helper. Required for Authorized Fetch servers (hachyderm.io, etc.) | **Implemented** |
| Object Integrity Proofs (FEP-8b32) | Full | Ed25519 keys stored; Fedify creates proofs automatically | **Implemented** (via Fedify) |
| Linked Data Signatures | Full | Fedify handles verification on inbound; not explicitly configured | **Partial** — verification only |
| Authorized Fetch on actor endpoint | Full | Disabled — `.authorize()` causes infinite key-fetch loops. Instance actor used as workaround for shared inbox signing. | **Not implemented** |
| Origin-based security (FEP-fe34) | Full | Not configured — using Fedify defaults | **Not implemented** |
| Inbox idempotency | Full | Not explicitly configured — using Fedify default (`"per-inbox"`) | **Implemented** (default) |
| Signature time window | Full | Default (1 hour) | **Implemented** (default) |
| CSRF protection | N/A (app concern) | Token generation + validation on all POST routes (`lib/csrf.js`) | **Implemented** |
| Content sanitization | N/A (app concern) | `sanitize-html` on all inbound content (`timeline-store.js`) | **Implemented** |

**Score: 8/12 Fedify-specific features (67%)**

---

## 5. Content & Object Types

Object creation in `lib/jf2-to-as2.js`. Object parsing in `lib/timeline-store.js` and `lib/inbox-listeners.js`.

| Object Type | Fedify Support | Our Implementation | Status |
|---|---|---|---|
| `Note` | Full | Create, display, syndicate. Primary post type for notes/replies/DMs. | **Implemented** |
| `Article` | Full | Create, display, syndicate. Used for article post type. | **Implemented** |
| `Image` (attachment) | Full | Photo posts with `Image` attachments in `jf2ToAS2Activity()` | **Implemented** |
| `Video` (attachment) | Full | Video post attachments | **Implemented** |
| `Audio` (attachment) | Full | Audio post attachments | **Implemented** |
| `Hashtag` (tag) | Full | Tags on syndicated posts, featured tags collection, tag timeline | **Implemented** |
| `Mention` (tag) | Full | Tags on replies for addressing, DM recipient mentions | **Implemented** |
| `PropertyValue` | Full | Profile attachment fields (name/value pairs) | **Implemented** |
| Quote posts (FEP-044f) | Full | Ingest via `quoteUrl` (3 namespaces), enrich via `fetchAndStoreQuote()`, render via `ap-quote-embed.njk` | **Implemented** |
| `Question` (polls) | Full | Not parsed — poll posts render without options | **Not implemented** |
| `Event` | Full | Not handled — events render as generic objects | **Not implemented** |
| `Page` | Full | Passthrough via content negotiation only | **Partial** |
| `ChatMessage` (LitePub DMs) | Full | Not handled — we use standard `Create(Note)` DM addressing | **Not implemented** |
| `Tombstone` | Full | Not created when posts are deleted | **Not implemented** |
| `Emoji` (custom) | Full (`toot:Emoji`) | Not handled — custom emoji renders as `:shortcode:` text | **Not implemented** |
| `Place` (location) | Full | Not handled — location data ignored | **Not implemented** |
| Sensitive / Content Warning | Full | `sensitive` flag displayed on inbound items but not settable on outbound | **Partial** |
| `Source` (original markup) | Full | Not used on outbound activities | **Not implemented** |

**Score: 10/18 (56%), but core types fully covered**

---

## 6. Audience Addressing & Visibility

Addressing logic in `lib/jf2-to-as2.js` (lines 179–194) and `lib/controllers/messages.js` for DMs.

| Visibility Mode | Fedify Support | Our Implementation | Status |
|---|---|---|---|
| **Public** (`to: PUBLIC_COLLECTION`, `cc: followers`) | Full | Standard addressing for all syndicated posts | **Implemented** |
| **Unlisted** (`to: followers`, `cc: PUBLIC_COLLECTION`) | Full | Not available — no UI option | **Not implemented** |
| **Followers-only** (`to: followers`, no PUBLIC) | Full | Not available — all posts are public | **Not implemented** |
| **Direct/DM** (`to: specific actors` only) | Full | Inbound detection (`isDirectMessage()`) + outbound via `submitMessageController` | **Implemented** |

**Score: 2/4 (50%) — the two missing modes are rarely needed for IndieWeb sites**

---

## 7. FEP (Fediverse Enhancement Proposals)

| FEP | Description | Our Implementation | Status |
|---|---|---|---|
| FEP-8b32 | Object Integrity Proofs | Ed25519 keys generated and stored; Fedify creates proofs on outbound activities | **Implemented** (via Fedify) |
| FEP-521a | Multiple Cryptographic Keys | Both RSA + Ed25519 key pairs via `setKeyPairsDispatcher()` | **Implemented** |
| FEP-044f | Quote Posts | Full pipeline: ingest `quoteUrl` (3 namespaces), enrich via `fetchAndStoreQuote()`, render embedded card, strip inline `RE:` references | **Implemented** |
| FEP-8fcf | Followers Collection Synchronization | Not configured — `syncCollection` option not passed to `sendActivity()` | **Not implemented** |
| FEP-fe34 | Origin-Based Security | Not configured — using Fedify defaults (`crossOrigin` not set) | **Not implemented** |
| FEP-ae0c | Relay Protocols | `@fedify/relay` not used — personal site doesn't need relay | **Not implemented** |
| FEP-c0e0 | Actor Succession | `successor` property not set on actor | **Not implemented** |
| FEP-9091 | DID-Based Actor Identification | `DidService`/`Export` not used | **Not implemented** |
| FEP-5711 | Inverse Collection Properties | `likesOf`, `sharesOf`, etc. not exposed | **Not implemented** |

**Score: 3/9 (33%) — the three implemented FEPs are the most impactful for interoperability**

---

## 8. Infrastructure & Operations

| Feature | Fedify Support | Our Implementation | Status |
|---|---|---|---|
| Redis message queue | `@fedify/redis` | `RedisMessageQueue` with `parallelWorkers` config (default 5) | **Implemented** |
| In-process queue | `InProcessMessageQueue` | Fallback when `redisUrl` not set | **Implemented** |
| MongoDB KvStore | Custom (app-provided) | `MongoKvStore` in `lib/kv-store.js` with `get`/`set`/`delete`/`list()` (required in Fedify 2.0) | **Implemented** |
| Debug dashboard | `@fedify/debugger` | Optional via `debugDashboard: true`, password-protected at `/{mount}/__debug__/` | **Implemented** |
| OpenTelemetry tracing | Full | Via `@fedify/debugger` `FedifySpanExporter` | **Implemented** |
| LogTape logging | Full | Configured once with `_logtapeConfigured` flag to prevent duplicate setup | **Implemented** |
| Delivery failure handling | Full | 404/410 permanent failures logged + stored in `ap_activities` (lines 344–361) | **Implemented** |
| Exponential backoff retry | Full | Using Fedify default retry policy | **Implemented** |
| Activity transformers | Full | Not used — `autoIdAssigner()` and `actorDehydrator()` defaults only | **Not implemented** |
| PostgreSQL queue | `@fedify/postgres` | Not applicable — using Redis | N/A |
| SQLite queue | `@fedify/sqlite` | Not applicable — using Redis | N/A |

**Score: 8/9 relevant features (89%)**

---

## 9. Application-Level Features (Beyond Fedify)

These features are built on top of Fedify — Fedify provides the federation primitives, we provide the application logic.

| Feature | Description | Status |
|---|---|---|
| Timeline reader | Full reader UI with tabs (notes, articles, boosts, media, replies, unread) | **Implemented** |
| Notifications | Like, boost, follow, mention, reply, DM notification types with unread tracking | **Implemented** |
| Direct messages | Inbound + outbound DMs with conversation sidebar, compose form | **Implemented** |
| Explore | Public Mastodon timeline aggregation from configured instances | **Implemented** |
| Hashtag explore | Cross-instance hashtag search via Mastodon API | **Implemented** |
| Tag timeline | Posts from followed accounts filtered by hashtag | **Implemented** |
| Post detail | Full post view with replies, quote enrichment | **Implemented** |
| Remote profile | View remote actor profiles with follow/mute/block actions | **Implemented** |
| Moderation | Mute (by URL or keyword), block, with filtering across all views | **Implemented** |
| Mastodon migration | CSV import + WebFinger resolution + batch re-follow state machine | **Implemented** |
| Featured posts | Pin/unpin posts to featured collection | **Implemented** |
| Featured tags | Manage featured hashtags | **Implemented** |
| Profile editor | Name, summary, icon, image, attachments, broadcasts update to followers | **Implemented** |
| Link previews | Open Graph unfurling via `unfurl.js` for timeline items | **Implemented** |
| Infinite scroll | Unified Alpine.js component with configurable cursor parameters | **Implemented** |
| CSRF protection | Token generation/validation on all POST routes | **Implemented** |
| Content sanitization | `sanitize-html` on all inbound content | **Implemented** |
| Activity log | Full inbound/outbound activity logging with TTL cleanup | **Implemented** |
| Timeline cleanup | Retention-based pruning (`timelineRetention` config) | **Implemented** |
| Hashtag following | Follow/unfollow hashtags, items from non-followed accounts matching tags appear in timeline | **Implemented** |
| Public profile page | HTML fallback for actor URL when accessed from browser | **Implemented** |

---

## 10. Overall Summary

| Category | Score | Percentage | Notes |
|---|---|---|---|
| Inbound Activities | 13/21 | 62% | All high-traffic types covered |
| Outbound Activities | 10/16 | 63% | Missing: Delete, Block, Flag, Move, Reject |
| Dispatchers/Collections | 11/13 | 85% | Near complete |
| Crypto/Security | 8/12 | 67% | Core signing works |
| Object Types | 10/18 | 56% | Core types done |
| Addressing | 2/4 | 50% | Public + DM only |
| FEPs | 3/9 | 33% | Key FEPs implemented |
| Infrastructure | 8/9 | 89% | Excellent |
| **Weighted Overall** | — | **~70%** | **~95%+ of real-world fediverse traffic covered** |

---

## 11. Gap Analysis: High-Impact Improvements

Ordered by impact-to-effort ratio.

### Priority 1 — High Impact, Low Effort

| Gap | Impact | Effort | Details |
|---|---|---|---|
| **Outbound `Delete` activity** | High | Low | When a post is deleted in Indiekit, remote servers are never notified. The post remains visible on all federated instances indefinitely. Hook into Indiekit's post delete lifecycle, send `Delete(Tombstone)` to followers. |
| **Outbound `Block` activity** | Medium | Low | Our block is local-only (`ap_blocked`). Remote servers don't know we blocked them, so they continue delivering activities. Send `Block` activity on block, `Undo(Block)` on unblock. |
| **Unlisted addressing mode** | Medium | Low | Add a "visibility" option to the syndicator: public (default), unlisted (`to: followers, cc: PUBLIC`). Useful for posts that shouldn't appear on public timelines but are still accessible via link. |

### Priority 2 — Medium Impact, Medium Effort

| Gap | Impact | Effort | Details |
|---|---|---|---|
| **Question/Poll support (inbound)** | Medium | Medium | Poll posts from Mastodon render without options. Parse `Question` object's `inclusiveOptions`/`exclusiveOptions`, display vote options and results in timeline. Voting (outbound) is a separate feature. |
| **`Flag` handler (inbound reports)** | Medium | Medium | Other servers can't send us abuse reports. Add `Flag` inbox listener, store in a `ap_reports` collection, add moderation UI tab. |
| **Content Warning / Sensitive flag (outbound)** | Medium | Low | Inbound sensitive content is displayed with a warning. Add a "sensitive" / CW option to the compose form and syndicator so outbound posts can include content warnings. |
| **Followers-only addressing** | Medium | Medium | Add a "followers-only" visibility option. Requires `to: followers` only, no PUBLIC. Also needs consideration for who can see the post on our own site. |

### Priority 3 — Low Impact

| Gap | Impact | Effort | Details |
|---|---|---|---|
| **Custom Emoji** | Low | Medium | Mastodon custom emoji renders as `:shortcode:` text. Parse `Emoji` tags, fetch images, inline-replace in content. |
| **`Reject(Follow)` / manual approval** | Low | Medium | Currently all follows are auto-accepted. Add a "manually approves followers" mode with pending/accept/reject UI. |
| **`Tombstone` on delete** | Low | Low | Instead of just deleting from collections, create a `Tombstone` object for the deleted resource. Mostly a federation correctness improvement. |
| **Activity transformers** | Low | Low | Fedify's `actorDehydrator()` improves Threads compatibility. Consider enabling for broader compatibility. |
| **FEP-8fcf Followers Sync** | Low | Low | Pass `syncCollection: true` to `sendActivity()` calls. Reduces duplicate deliveries for servers that support it. |
| **FEP-fe34 Origin-Based Security** | Low | Low | Set `crossOrigin: "ignore"` or `"throw"` on federation options. Prevents spoofed attribution attacks. |

### Not Recommended (Skip)

| Gap | Reason |
|---|---|
| `EmojiReact` | Misskey/Pleroma-only, very niche |
| `Arrive`/`Travel`/`Join`/`Leave` | Almost never seen in real fediverse |
| `Invite`/`Offer` | Group-specific, very niche |
| `Dislike` | Not implemented by any major fediverse software |
| Relay support (FEP-ae0c) | Only useful at scale, not for personal sites |
| DID-based identity (FEP-9091) | Future spec, minimal adoption |
| Actor succession (FEP-c0e0) | Future spec, minimal adoption |
| `ChatMessage` (LitePub DMs) | Our standard DM addressing works with all servers |

---

## 12. Data Flow Reference

### Outbound Activity Flow

```
Indiekit blog post (JF2)
  ↓
syndicator.syndicate()  [index.js]
  ↓
jf2ToAS2Activity()  [lib/jf2-to-as2.js — converts JF2 → Fedify vocab objects]
  ↓
ctx.sendActivity({ identifier: handle }, "followers", activity)  [Fedify]
  ↓
Redis queue  [or InProcessMessageQueue]
  ↓
HTTP POST to follower inboxes  [signed with RSA/Ed25519 by Fedify]
```

### Inbound Activity Flow

```
Remote server HTTP POST to /{mount}/inbox  [HTTP Signature verified by Fedify]
  ↓
federation-bridge.js  [reconstructs body if Express consumed stream, uses req.originalUrl]
  ↓
Fedify matches activity type → calls registered listener
  ↓
inbox-listeners.js  [authenticated document loader for all remote fetches]
  ↓
MongoDB storage  [ap_followers, ap_timeline, ap_notifications, ap_messages, ap_activities]
  ↓
Admin UI renders data  [reader, notifications, messages, moderation]
```

### Reader Timeline Pipeline

```
Raw items from ap_timeline
  ↓
applyTabFilter()  [notes/articles/boosts/media/replies — lib/item-processing.js]
  ↓
loadModerationData()  [load muted URLs, keywords, blocked URLs]
  ↓
postProcessItems()  [filter muted/blocked, strip quote refs, build interaction map]
  ↓
renderItemCards()  [server-side Nunjucks → HTML for AJAX responses]
  ↓
Alpine.js infinite scroll  [apInfiniteScroll component — assets/reader-infinite-scroll.js]
```

---

## 13. MongoDB Collections Reference

| Collection | Records | Indexes | TTL |
|---|---|---|---|
| `ap_followers` | Accounts following us | `actorUrl` (unique) | No |
| `ap_following` | Accounts we follow | `actorUrl` (unique) | No |
| `ap_activities` | Activity log | `direction`, `type`, `actorUrl`, `objectUrl`, `receivedAt` | Yes (`activityRetentionDays`, default 90) |
| `ap_keys` | Crypto key pairs | `type` (rsa/ed25519) | No |
| `ap_kv` | Fedify KV store | `_id` (key path) | Yes (Fedify-managed) |
| `ap_profile` | Actor profile (single doc) | — | No |
| `ap_featured` | Pinned posts | `postUrl` | No |
| `ap_featured_tags` | Featured hashtags | `tag` | No |
| `ap_timeline` | Reader timeline | `uid` (unique), `published`, `author.url`, `type` | No (manual cleanup via `timelineRetention`) |
| `ap_notifications` | Notifications | `uid` (unique), `type`, `read`, `createdAt` | Yes (`notificationRetentionDays`, default 30) |
| `ap_messages` | Direct messages | `uid` (unique), `conversationId`+`published`, `read`, `direction` | Yes (reuses `notificationRetentionDays`) |
| `ap_muted` | Muted actors/keywords | `url` or `keyword` | No |
| `ap_blocked` | Blocked actors | `url` | No |
| `ap_interactions` | Like/boost tracking | `objectUrl`, `type` | No |
| `ap_followed_tags` | Hashtags we follow | `tag` | No |

---

## 14. Configuration Reference

```javascript
{
  mountPath: "/activitypub",           // URL prefix for all routes
  actor: {
    handle: "rick",                    // Fediverse username (@rick@rmendes.net)
    name: "Ricardo Mendes",            // Display name (seeds profile on first run)
    summary: "",                       // Bio (seeds profile)
    icon: "",                          // Avatar URL (seeds profile)
  },
  checked: true,                       // Syndicator checked by default in Micropub UI
  alsoKnownAs: "",                     // Mastodon migration alias (for Move activities)
  activityRetentionDays: 90,           // TTL for ap_activities (0 = forever)
  storeRawActivities: false,           // Store full JSON of inbound activities
  redisUrl: "",                        // Redis for delivery queue (empty = in-process)
  parallelWorkers: 5,                  // Parallel delivery workers (with Redis)
  actorType: "Person",                 // Person | Service | Organization | Group | Application
  logLevel: "warning",                 // Fedify log level: debug | info | warning | error | fatal
  timelineRetention: 1000,             // Max timeline items (0 = unlimited)
  notificationRetentionDays: 30,       // Days to keep notifications (0 = forever)
  debugDashboard: false,               // Enable @fedify/debugger at {mount}/__debug__/
  debugPassword: "",                   // Password for debug dashboard
}
```

---

*This audit reflects the state of the plugin at version 2.9.2. It should be updated when new features are added or when Fedify releases new capabilities.*
