# Fedify Feature Completeness Implementation Plan

Created: 2026-02-20
Status: COMPLETE
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
> **Worktree:** Set at plan creation (from dispatcher). `Yes` uses git worktree isolation; `No` works directly on current branch (default)

## Summary

**Goal:** Implement all missing Fedify features in the `@rmdes/indiekit-endpoint-activitypub` plugin to achieve near-complete Fedify API coverage — delivery reliability (permanent failure handling, ordering keys, collection sync), content resolution (object dispatcher), standard collections (liked, featured, featured tags), access control (authorized fetch, instance actor), and quality-of-life improvements (dynamic NodeInfo, parallel queue, handle aliases).

**Architecture:** All changes are additive to the existing `federation-setup.js` architecture. New dispatchers/handlers are registered on the same `federation` instance returned by `createFederation()`. New MongoDB collections are added via `Indiekit.addCollection()` in `index.js`. Admin UI views follow the existing Nunjucks template pattern in `views/`. The plugin's syndicator, inbox listeners, and existing collection dispatchers remain unchanged.

**Tech Stack:** Fedify ^1.10.0, @fedify/redis ^1.10.3, MongoDB, Express 5, Nunjucks templates, ioredis

## Scope

### In Scope

- Permanent failure handler for dead inboxes
- Followers collection sync (FEP-8fcf) on sendActivity
- Ordering keys on all sendActivity calls
- Object dispatcher for Note/Article resolution
- Liked collection dispatcher
- Featured (pinned) collection dispatcher + admin UI
- Featured tags collection dispatcher + admin UI
- Instance actor (Application type) for domain-level federation
- Authorized fetch with admin toggle
- ParallelMessageQueue wrapper
- Dynamic NodeInfo version from package.json
- Handle aliases via mapAlias
- Configurable actor type (Person/Service/Application)
- Context data propagation (handle + publicationUrl)
- Investigate and fix syndication delivery issues

### Out of Scope

- Custom collections API (extensible plugin system for registering arbitrary collections)
- Relay support (FEP-ae0c)
- Key rotation admin UI (deferred — keys are already dual RSA+Ed25519)
- Custom WebFinger links
- Separate inbox/outbox queue configuration

## Prerequisites

- Plugin repo at `/home/rick/code/indiekit-dev/indiekit-endpoint-activitypub`
- Cloudron deployment at `/home/rick/code/indiekit-dev/indiekit-cloudron`
- Fedify docs at `/home/rick/code/fedify/docs/manual/`
- Test suite at `/home/rick/code/indiekit-dev/activitypub-tests/`
- Node.js 22, MongoDB, Redis available on Cloudron

## Context for Implementer

> This section is critical for cross-session continuity. Write it for an implementer who has never seen the codebase.

- **Patterns to follow:** All Fedify dispatchers are registered in `lib/federation-setup.js` using the pattern `federation.setXxxDispatcher(urlPattern, callback)` with `.setCounter()` and `.setFirstCursor()` chained (see `setupFollowers` at line 285, `setupOutbox` at line 345).
- **Conventions:** ESM modules (`"type": "module"`), no build step. MongoDB collections registered via `Indiekit.addCollection("name")` in `index.js:init()`. Dates stored as ISO strings. Admin views are Nunjucks templates in `views/` rendered by controllers in `lib/controllers/`.
- **Key files:**
  - `index.js` — Plugin entry point, constructor defaults, `init()`, syndicator, routes
  - `lib/federation-setup.js` — All Fedify configuration (actor, inbox, collections, NodeInfo)
  - `lib/inbox-listeners.js` — Inbox activity handlers (Follow, Undo, Like, etc.)
  - `lib/jf2-to-as2.js` — Converts Indiekit JF2 posts to ActivityStreams objects
  - `lib/activity-log.js` — Logs activities to `ap_activities` collection
  - `lib/kv-store.js` — MongoDB-backed KvStore for Fedify
  - `package.json` — Dependencies, version (currently 1.0.21)
- **Gotchas:**
  - `init()` is synchronous — cannot use `await`. All async work (profile seeding, batch refollow) uses `.catch()` or `setTimeout()`.
  - The syndicator's `syndicate(properties)` returns the post URL on success or `undefined` on skip/failure.
  - `createFederation()` options like `onOutboxError` and `permanentFailureStatusCodes` are set at creation time, not after.
  - The `setOutboxPermanentFailureHandler()` is called on the federation instance AFTER creation.
  - `ctx.sendActivity()` options: `{ preferSharedInbox, syncCollection, orderingKey }`.
- **Domain context:** Indiekit stores posts as JF2 objects in MongoDB `posts` collection with `properties.url`, `properties.published`, `properties["post-type"]`, etc. The `jf2ToAS2Activity()` function converts these to Fedify Activity objects.

## Runtime Environment

- **Start command:** `node --import @indiekit/indiekit/register index.js` (via Cloudron start.sh)
- **Port:** 8080 (Indiekit), 3000 (nginx)
- **Deploy path:** Cloudron at rmendes.net
- **Health check:** `curl -s https://rmendes.net/.well-known/webfinger?resource=acct:rick@rmendes.net`
- **Restart procedure:** `cloudron build --no-cache && cloudron update --app rmendes.net --no-backup`

## Progress Tracking

**MANDATORY: Update this checklist as tasks complete. Change `[ ]` to `[x]`.**

- [x] Task 1: Investigate and fix syndication delivery
- [x] Task 2: Permanent failure handler (SKIPPED — requires Fedify 2.0+)
- [x] Task 3: Ordering keys on sendActivity
- [x] Task 4: Followers collection sync (FEP-8fcf)
- [x] Task 5: Dynamic NodeInfo version
- [x] Task 6: Context data propagation
- [x] Task 7: Object dispatcher for Note/Article
- [x] Task 8: Liked collection
- [x] Task 9: Featured (pinned) collection + admin UI
- [x] Task 10: Featured tags collection + admin UI
- [x] Task 11: Instance actor
- [x] Task 12: Authorized fetch with admin toggle
- [x] Task 13: ParallelMessageQueue
- [x] Task 14: Handle aliases (mapAlias)
- [x] Task 15: Configurable actor type
- [x] Task 16: New test scripts
- [x] Task 17: Version bump + Cloudron config update

**Total Tasks:** 17 | **Completed:** 17 | **Remaining:** 0

## Implementation Tasks

### Task 1: Investigate and fix syndication delivery

**Objective:** The user reports new posts are not appearing on their fediverse profile despite syndication logs showing "Sent Create to 830 followers". Investigate whether the issue is delivery (queue not processing), content resolution (remote servers can't fetch the post), or something else entirely.

**Dependencies:** None

**Files:**
- Investigate: `lib/federation-setup.js` (queue startup, sendActivity)
- Investigate: `index.js` (syndicator.syndicate method)
- Investigate: `lib/jf2-to-as2.js` (activity structure)

**Key Decisions / Notes:**
- Check if `federation.startQueue()` is working correctly
- Check if the activities in the Redis queue are actually being processed (not just enqueued)
- Test whether a remote Mastodon instance can fetch the content negotiation response and display it
- Check if the `Create` activity wrapping is correct (Mastodon requires `Create(Note)`, not bare `Note`)
- Use `fedify lookup` CLI to test if the actor and posts resolve correctly from external perspective

**Definition of Done:**
- [ ] Root cause of syndication failure identified
- [ ] Fix implemented (if code change needed)
- [ ] Verified a new post appears on fediverse profile after syndication

**Verify:**
- `fedify lookup acct:rick@rmendes.net` — actor resolves with outbox
- `curl -s -H "Accept: application/activity+json" https://rmendes.net/notes/YYYY/MM/DD/slug` — returns valid AS2 Note
- Check Mastodon instance shows the post

---

### Task 2: Permanent failure handler

**Objective:** Register `setOutboxPermanentFailureHandler()` on the federation instance to automatically remove followers whose inboxes return 404/410. Log these events to `ap_activities`.

**Dependencies:** None

**Files:**
- Modify: `lib/federation-setup.js` — add handler after `createFederation()`
- Modify: `lib/federation-setup.js` — add `permanentFailureStatusCodes: [404, 410, 451]` to createFederation options

**Key Decisions / Notes:**
- The handler receives `{ inbox, activity, error, statusCode, actorIds }` via `values` parameter
- `values.actorIds` are URL objects — match against `ap_followers.actorUrl` (string comparison with `.href`)
- When `preferSharedInbox: true`, one inbox may represent multiple followers
- Log each removal as an activity with type "PermanentFailure"
- Don't throw errors in the handler (Fedify catches and ignores them anyway)

**Definition of Done:**
- [ ] `setOutboxPermanentFailureHandler` registered on federation instance
- [ ] Dead followers removed from `ap_followers` when inbox returns 404/410/451
- [ ] Permanent failures logged to `ap_activities` with direction "system"
- [ ] `permanentFailureStatusCodes` set to `[404, 410, 451]`

**Verify:**
- Check that `permanentFailureStatusCodes` appears in `createFederation()` call
- Check that `setOutboxPermanentFailureHandler` is called on the federation instance
- `node -e "import('./lib/federation-setup.js')"` — no import errors

---

### Task 3: Ordering keys on sendActivity

**Objective:** Add `orderingKey` to all `ctx.sendActivity()` calls so that related activities (Create→Update→Delete for the same post) are delivered in order per recipient server.

**Dependencies:** None

**Files:**
- Modify: `index.js` — syndicator.syndicate method (line ~331 and ~341)
- Modify: `index.js` — followActor method (line ~426)
- Modify: `index.js` — unfollowActor method (line ~534)

**Key Decisions / Notes:**
- For post syndication: `orderingKey: properties.url` — ensures Create/Update/Delete for same post are ordered
- For follow/unfollow: `orderingKey: actorUrl` — ensures Follow then Undo(Follow) arrive in order
- Don't add ordering keys for unrelated activities (reduces parallelism)
- The ordering key is per-recipient-server — two servers can receive in parallel

**Definition of Done:**
- [ ] `orderingKey` added to sendActivity in syndicator.syndicate (both followers and reply-to-author calls)
- [ ] `orderingKey` added to sendActivity in followActor
- [ ] `orderingKey` added to sendActivity in unfollowActor

**Verify:**
- Grep for `sendActivity` — every call should have `orderingKey` in its options
- `node -e "import('./index.js')"` — no import errors

---

### Task 4: Followers collection sync (FEP-8fcf)

**Objective:** Add `preferSharedInbox: true` and `syncCollection: true` to the `sendActivity` call that sends to `"followers"` in the syndicator.

**Dependencies:** None

**Files:**
- Modify: `index.js` — syndicator.syndicate method, the `ctx.sendActivity({ identifier: handle }, "followers", activity)` call (~line 331)

**Key Decisions / Notes:**
- `syncCollection: true` is ONLY valid when recipients is `"followers"` (string)
- `preferSharedInbox: true` consolidates delivery to shared inboxes (more efficient)
- Fedify automatically includes a followers collection digest in the delivery payload
- This implements FEP-8fcf for Mastodon-compatible servers

**Definition of Done:**
- [ ] `sendActivity` to `"followers"` includes `{ preferSharedInbox: true, syncCollection: true }`
- [ ] Other `sendActivity` calls (to specific actors) do NOT include `syncCollection`

**Verify:**
- Read the syndicate method and confirm the options are present on the followers call only

---

### Task 5: Dynamic NodeInfo version

**Objective:** Read the actual Indiekit version from `@indiekit/indiekit` package.json instead of hardcoding `{ major: 1, minor: 0, patch: 0 }`.

**Dependencies:** None

**Files:**
- Modify: `lib/federation-setup.js` — NodeInfo dispatcher (~line 253)

**Key Decisions / Notes:**
- Use `import { createRequire } from "node:module"` and `createRequire(import.meta.url)` to resolve `@indiekit/indiekit/package.json`
- Or use a simpler approach: read the version from `@indiekit/indiekit` package.json at module load time
- Parse semver string "1.0.0-beta.25" → `{ major: 1, minor: 0, patch: 0 }` (ignore prerelease)
- Fallback to `{ major: 1, minor: 0, patch: 0 }` if resolution fails

**Definition of Done:**
- [ ] NodeInfo dispatcher reads version from @indiekit/indiekit package.json
- [ ] Version parsed correctly into `{ major, minor, patch }` format
- [ ] Fallback to 1.0.0 if package.json can't be found

**Verify:**
- `curl -s https://rmendes.net/nodeinfo/2.1 | jq .software.version` — should return actual version
- Test script: `tests/02-nodeinfo.sh` passes

---

### Task 6: Context data propagation

**Objective:** Pass `handle` and `publicationUrl` in the Fedify context data instead of using closures, so dispatchers and handlers have cleaner access to these values.

**Dependencies:** None

**Files:**
- Modify: `lib/federation-setup.js` — `createFederation()` and all `createContext()` calls
- Modify: `index.js` — all `this._federation.createContext()` calls in syndicator, followActor, unfollowActor

**Key Decisions / Notes:**
- Currently `createContext(new URL(publicationUrl), {})` passes empty context
- Change to `createContext(new URL(publicationUrl), { handle, publicationUrl })`
- This doesn't change any behavior — it just makes the data available via `ctx.data` in dispatchers
- Future tasks (object dispatcher, collections) will use `ctx.data.handle` and `ctx.data.publicationUrl`

**Definition of Done:**
- [ ] `createContext()` calls pass `{ handle, publicationUrl }` as context data
- [ ] No behavioral changes — existing functionality preserved

**Verify:**
- `node -e "import('./index.js')"` — no import errors
- Existing test suite passes

---

### Task 7: Object dispatcher for Note/Article

**Objective:** Register `setObjectDispatcher()` for `Note` and `Article` types so individual posts are dereferenceable at proper Fedify-managed URIs. This is critical for remote servers to properly display shared content.

**Dependencies:** Task 6 (context data propagation)

**Files:**
- Modify: `lib/federation-setup.js` — add `setupObjectDispatchers()` function and call it
- Read: `lib/jf2-to-as2.js` — understand how posts are converted to AS2

**Key Decisions / Notes:**
- Register `federation.setObjectDispatcher(Note, ...)` and `federation.setObjectDispatcher(Article, ...)`
- URL pattern: `${mountPath}/objects/note/{id}` and `${mountPath}/objects/article/{id}`
- The `{id}` maps to the post's URL slug (e.g., `notes/2026/02/20/52ef4`)
- Dispatcher looks up the post in MongoDB `posts` collection by URL and converts to AS2
- Use `{+id}` (reserved expansion) since IDs contain slashes
- This complements the existing content-negotiation route — Fedify handles proper ActivityPub discovery while content negotiation handles direct URL requests

**Definition of Done:**
- [ ] `setObjectDispatcher(Note, ...)` registered for note/reply/like/repost/bookmark/jam/rsvp posts
- [ ] `setObjectDispatcher(Article, ...)` registered for article posts
- [ ] Dispatcher looks up post in MongoDB and returns proper Fedify Note/Article object
- [ ] Actor dispatcher references `liked` and `featured` URIs (prepared for later tasks)

**Verify:**
- `curl -s -H "Accept: application/activity+json" "https://rmendes.net/activitypub/objects/note/notes%2F2026%2F02%2F20%2F52ef4"` — returns AS2 Note
- Existing content negotiation still works

---

### Task 8: Liked collection

**Objective:** Expose a `liked` collection showing objects the actor has liked. Query the MongoDB `posts` collection for `post-type: "like"` posts and return their `like-of` URLs.

**Dependencies:** Task 6

**Files:**
- Modify: `lib/federation-setup.js` — add `setupLiked()` function
- Modify: `lib/federation-setup.js` — call `setupLiked()` in `setupFederation()`
- Modify: actor dispatcher to include `liked: ctx.getLikedUri(identifier)`

**Key Decisions / Notes:**
- Pattern: `${mountPath}/users/{identifier}/liked`
- Query: `collections.posts.find({ "properties.post-type": "like" })` sorted by published desc
- Return items as URLs: `new URL(post.properties["like-of"])` for each like post
- Include `.setCounter()` and `.setFirstCursor()` for pagination (same pattern as followers)
- Add `liked` property to the Person actor options

**Definition of Done:**
- [ ] `setLikedDispatcher` registered with pagination
- [ ] Actor includes `liked` URI in Person properties
- [ ] Collection returns liked object URLs

**Verify:**
- `curl -s -H "Accept: application/activity+json" "https://rmendes.net/activitypub/users/rick/liked"` — returns OrderedCollection
- New test script added

---

### Task 9: Featured (pinned) collection + admin UI

**Objective:** Expose a `featured` collection for pinned posts and add an admin UI to manage them. Store pinned post URLs in a new `ap_featured` MongoDB collection.

**Dependencies:** Task 6

**Files:**
- Modify: `lib/federation-setup.js` — add `setupFeatured()` function
- Modify: `index.js` — register `ap_featured` collection, add admin routes
- Create: `lib/controllers/featured.js` — admin controller for pin/unpin
- Create: `views/featured.njk` — admin template for managing pinned posts
- Modify: actor dispatcher to include `featured: ctx.getFeaturedUri(identifier)`

**Key Decisions / Notes:**
- New collection `ap_featured` stores `{ postUrl, pinnedAt }` documents
- Pattern: `${mountPath}/users/{identifier}/featured`
- Dispatcher returns the full Note/Article objects (not just URLs) — Mastodon expects objects
- Admin UI at `/activitypub/admin/featured` — list pinned posts, pin/unpin buttons
- Pin limit: 5 posts max (Mastodon convention)
- On pin: look up post in `posts` collection, convert to AS2 Note/Article, store URL in `ap_featured`
- On unpin: remove from `ap_featured`

**Definition of Done:**
- [ ] `setFeaturedDispatcher` registered, returns AS2 objects for pinned posts
- [ ] `ap_featured` MongoDB collection registered
- [ ] Admin UI at `/activitypub/admin/featured` to manage pins
- [ ] Actor includes `featured` URI in Person properties
- [ ] Pin limit of 5 enforced

**Verify:**
- `curl -s -H "Accept: application/activity+json" "https://rmendes.net/activitypub/users/rick/featured"` — returns OrderedCollection
- Admin UI renders at `/activitypub/admin/featured`

---

### Task 10: Featured tags collection + admin UI

**Objective:** Expose a `featured tags` collection for hashtags the actor wants to highlight. Store them in a new `ap_featured_tags` MongoDB collection with an admin UI.

**Dependencies:** Task 6

**Files:**
- Modify: `lib/federation-setup.js` — add `setupFeaturedTags()` function
- Modify: `index.js` — register `ap_featured_tags` collection, add admin routes
- Create: `lib/controllers/featured-tags.js` — admin controller
- Create: `views/featured-tags.njk` — admin template
- Modify: actor dispatcher to include `featuredTags: ctx.getFeaturedTagsUri(identifier)`

**Key Decisions / Notes:**
- New collection `ap_featured_tags` stores `{ tag, addedAt }` documents
- Pattern: `${mountPath}/users/{identifier}/tags`
- Dispatcher returns `Hashtag` objects with `name` (`#tag`) and `href` (link to tag page)
- Import `Hashtag` from `@fedify/fedify`
- Admin UI at `/activitypub/admin/tags` — add/remove featured tags
- Tag href: `${publicationUrl}categories/${encodeURIComponent(tag)}`

**Definition of Done:**
- [ ] `setFeaturedTagsDispatcher` registered, returns Hashtag objects
- [ ] `ap_featured_tags` MongoDB collection registered
- [ ] Admin UI at `/activitypub/admin/tags` to manage featured tags
- [ ] Actor includes `featuredTags` URI

**Verify:**
- `curl -s -H "Accept: application/activity+json" "https://rmendes.net/activitypub/users/rick/tags"` — returns Collection of Hashtags
- Admin UI renders

---

### Task 11: Instance actor

**Objective:** Create an Application-type instance actor (`rmendes.net@rmendes.net`) that represents the domain itself. This is required for authorized fetch to work without infinite loops.

**Dependencies:** Task 6

**Files:**
- Modify: `lib/federation-setup.js` — extend actor dispatcher to handle instance actor identifier
- Modify: `lib/federation-setup.js` — extend key pairs dispatcher for instance actor
- Modify: `lib/federation-setup.js` — extend `mapHandle` to accept hostname

**Key Decisions / Notes:**
- When `identifier === ctx.hostname` (e.g., "rmendes.net"), return an `Application` actor
- Import `Application` from `@fedify/fedify`
- Instance actor uses the same RSA+Ed25519 key pairs as the main actor (simplicity)
- Instance actor properties: `id`, `preferredUsername: hostname`, `inbox`, `outbox` (empty)
- `mapHandle` returns hostname when username matches hostname
- The instance actor does NOT need followers/following/liked/featured collections

**Definition of Done:**
- [ ] Actor dispatcher returns `Application` when identifier is hostname
- [ ] Key pairs dispatcher returns keys for hostname identifier
- [ ] `mapHandle` accepts hostname as valid username
- [ ] Instance actor resolves via WebFinger: `acct:rmendes.net@rmendes.net`

**Verify:**
- `fedify lookup acct:rmendes.net@rmendes.net` — returns Application actor
- `curl -s -H "Accept: application/activity+json" "https://rmendes.net/activitypub/users/rmendes.net"` — returns Application

---

### Task 12: Authorized fetch with admin toggle

**Objective:** Add optional authorized fetch support via `.authorize()` predicates on the actor and collection dispatchers. Controlled by a config option and admin toggle.

**Dependencies:** Task 11 (instance actor needed to prevent infinite loops)

**Files:**
- Modify: `lib/federation-setup.js` — add `.authorize()` to actor, collections
- Modify: `index.js` — add `authorizedFetch: false` to defaults, pass to setupFederation
- Modify: `views/dashboard.njk` or `views/profile.njk` — add toggle (or use ap_profile)

**Key Decisions / Notes:**
- When `authorizedFetch` is enabled:
  - Actor dispatcher: `.authorize()` returns true for instance actor, checks signed key for others
  - Collections: `.authorize()` same logic
- When `authorizedFetch` is disabled (default): don't chain `.authorize()` at all
- Store setting in `ap_profile.authorizedFetch` (boolean)
- The `authorize` predicate: `ctx.getSignedKeyOwner({ documentLoader: await ctx.getDocumentLoader({ identifier: ctx.hostname }) })`
- Instance actor is always accessible without auth (prevents infinite loops)

**Definition of Done:**
- [ ] `.authorize()` chained on actor and collection dispatchers when enabled
- [ ] Instance actor always returns true (no auth required)
- [ ] Config option `authorizedFetch` defaults to false
- [ ] Setting stored in ap_profile for runtime toggle

**Verify:**
- With `authorizedFetch: false` — unsigned GET requests work normally
- Check that `.authorize()` is conditionally applied

---

### Task 13: ParallelMessageQueue

**Objective:** Wrap the Redis message queue with `ParallelMessageQueue` for concurrent activity processing. Add a config option for the number of workers.

**Dependencies:** None

**Files:**
- Modify: `lib/federation-setup.js` — wrap queue with ParallelMessageQueue
- Modify: `index.js` — add `parallelWorkers: 5` to defaults

**Key Decisions / Notes:**
- Import `ParallelMessageQueue` from `@fedify/fedify`
- When `redisUrl` is set AND `parallelWorkers > 1`: wrap `RedisMessageQueue` with `ParallelMessageQueue`
- When `parallelWorkers <= 1` or no Redis: don't wrap (single worker)
- Default: 5 workers (good balance for ~800 followers)
- `ParallelMessageQueue` inherits `nativeRetrial` from the wrapped queue

**Definition of Done:**
- [ ] `ParallelMessageQueue` wraps Redis queue when parallelWorkers > 1
- [ ] Config option `parallelWorkers` with default 5
- [ ] InProcessMessageQueue is NOT wrapped (only used in dev)

**Verify:**
- Console log shows "Using Redis message queue with 5 parallel workers"
- `node -e "import('./lib/federation-setup.js')"` — no import errors

---

### Task 14: Handle aliases (mapAlias)

**Objective:** Register `mapAlias()` so that the actor's profile URL and common alias patterns resolve via WebFinger.

**Dependencies:** None

**Files:**
- Modify: `lib/federation-setup.js` — chain `.mapAlias()` on actor dispatcher

**Key Decisions / Notes:**
- When someone queries WebFinger for the profile URL (e.g., `https://rmendes.net/`), resolve to the actor
- Pattern: check if `resource.hostname` matches and `resource.pathname` is `/` or `/@handle`
- Return `{ identifier: handle }` for matching URLs
- This allows `https://rmendes.net/` to be discoverable via WebFinger alongside `acct:rick@rmendes.net`

**Definition of Done:**
- [ ] `mapAlias()` registered on actor dispatcher
- [ ] Profile URL resolves via WebFinger
- [ ] `/@handle` pattern resolves via WebFinger

**Verify:**
- `curl -s "https://rmendes.net/.well-known/webfinger?resource=https://rmendes.net/"` — returns actor link
- `curl -s "https://rmendes.net/.well-known/webfinger?resource=https://rmendes.net/@rick"` — returns actor link

---

### Task 15: Configurable actor type

**Objective:** Add a config option to choose the actor type (Person, Service, Application) instead of hardcoding Person.

**Dependencies:** Task 11 (instance actor uses Application)

**Files:**
- Modify: `lib/federation-setup.js` — use config-based actor class
- Modify: `index.js` — add `actorType: "Person"` to defaults

**Key Decisions / Notes:**
- Import `Person`, `Service`, `Application`, `Organization`, `Group` from `@fedify/fedify`
- Map string config to class: `{ Person, Service, Application, Organization, Group }`
- Instance actor always uses `Application` regardless of config
- Default: "Person" (most common for individual blogs)

**Definition of Done:**
- [ ] Config option `actorType` with default "Person"
- [ ] Actor dispatcher uses configured type class
- [ ] Instance actor always uses Application

**Verify:**
- Actor endpoint returns `type: "Person"` by default
- Config change to "Service" would change the type field

---

### Task 16: New test scripts

**Objective:** Add test scripts for the new features: liked collection, featured collection, featured tags, instance actor, and handle aliases.

**Dependencies:** Tasks 7-14

**Files:**
- Create: `activitypub-tests/tests/13-liked.sh`
- Create: `activitypub-tests/tests/14-featured.sh`
- Create: `activitypub-tests/tests/15-featured-tags.sh`
- Create: `activitypub-tests/tests/16-instance-actor.sh`
- Create: `activitypub-tests/tests/17-object-dispatcher.sh`
- Create: `activitypub-tests/tests/18-webfinger-alias.sh`

**Key Decisions / Notes:**
- Follow existing test pattern in `tests/common.sh` (BASE_URL, curl, jq assertions)
- Each test verifies the HTTP response and JSON structure
- Liked: GET liked collection, verify OrderedCollection type
- Featured: GET featured collection, verify OrderedCollection type
- Featured tags: GET tags collection, verify items are Hashtag type
- Instance actor: WebFinger + actor endpoint for hostname identifier
- Object dispatcher: GET object URI, verify Note/Article type
- WebFinger alias: query WebFinger with profile URL

**Definition of Done:**
- [ ] All 6 test scripts created and passing
- [ ] `run-all.sh` updated to include new tests

**Verify:**
- `cd activitypub-tests && bash run-all.sh` — all tests pass

---

### Task 17: Version bump + Cloudron config update

**Objective:** Bump plugin version, update Cloudron Dockerfile and config files, prepare for deployment.

**Dependencies:** All previous tasks

**Files:**
- Modify: `package.json` — bump version to 1.0.22
- Modify: `/home/rick/code/indiekit-dev/indiekit-cloudron/Dockerfile` — update version
- Modify: `/home/rick/code/indiekit-dev/indiekit-cloudron/indiekit.config.js.template` — add new config options
- Modify: `/home/rick/code/indiekit-dev/indiekit-cloudron/indiekit.config.js.rmendes` — add new config options

**Key Decisions / Notes:**
- New config options to add: `authorizedFetch`, `parallelWorkers`, `actorType`
- Register new collections `ap_featured` and `ap_featured_tags` (automatic via plugin init)
- Bump CACHE_BUST in Dockerfile

**Definition of Done:**
- [ ] Version bumped to 1.0.22
- [ ] Dockerfile references @1.0.22
- [ ] Config templates updated with new options
- [ ] CACHE_BUST incremented

**Verify:**
- `jq .version package.json` — returns "1.0.22"
- `grep "1.0.22" /home/rick/code/indiekit-dev/indiekit-cloudron/Dockerfile` — found

---

## Testing Strategy

- **Shell tests:** Extend existing `activitypub-tests/` suite with 6 new tests (Task 16)
- **Integration testing:** Deploy to Cloudron and verify:
  - All existing 12 tests still pass
  - New 6 tests pass
  - `fedify lookup` resolves actor, instance actor, and post objects
  - Posts syndicated after deploy appear on fediverse (Mastodon search)
- **Manual verification:**
  - Admin UI pages render for featured posts, featured tags
  - Pin/unpin a post and verify it appears in featured collection
  - Add/remove a tag and verify featured tags collection

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Fedify API version incompatibility (features require newer Fedify) | Low | High | Check Fedify version in package.json (^1.10.0) — most features available since 0.7-1.0. ParallelMessageQueue since 1.0. Permanent failure handler since 2.0 — verify this is available |
| Breaking existing federation by changing actor properties | Medium | High | Test with `fedify lookup` before and after. Ensure `publicKey` and `assertionMethods` unchanged. Instance actor uses separate identifier |
| MongoDB index conflicts with existing collections | Low | Medium | Use `createIndex` with `background: true` and catch errors |
| Redis queue wrapper breaking delivery | Low | High | Only wrap when `parallelWorkers > 1` and Redis is configured. Fallback to unwrapped queue if ParallelMessageQueue import fails |
| Authorized fetch blocking legitimate unsigned requests | Medium | Medium | Default to `authorizedFetch: false`. Only enable when explicitly configured. Instance actor always allows unsigned access |

## Open Questions

- Is `setOutboxPermanentFailureHandler` available in Fedify ^1.10.0? The docs say "since 2.0.0" — if the installed version is <2.0, we'll need to skip this feature or use `onOutboxError` as a fallback.
- The `ParallelMessageQueue` docs say "since 1.0.0" which should be fine with ^1.10.0.

### Deferred Ideas

- Custom collections API for other plugins to register arbitrary collections
- Relay support (FEP-ae0c) for large-scale content distribution
- Key rotation admin UI with grace period
- Activity transformers for custom pre-send validation
- Separate inbox/outbox queue configuration for different processing priorities
