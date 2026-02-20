# Fedify Migration Plan — Full Adoption

**Status:** DRAFT
**Plugin:** `@rmdes/indiekit-endpoint-activitypub`
**Current version:** 0.1.10
**Target version:** 0.2.0

## Executive Summary

The plugin currently declares `@fedify/fedify` and `@fedify/express` as dependencies but uses **none** of their APIs. All federation logic is hand-rolled using Node's `crypto` module. This plan migrates to proper Fedify adoption, replacing ~400 lines of manual cryptography, signature handling, and protocol plumbing with Fedify's battle-tested implementation.

## Why Migrate

| Concern | Current (hand-rolled) | After (Fedify) |
|---------|----------------------|----------------|
| **HTTP Signatures** | Manual `createSign`/`createVerify` — only Draft Cavage | Automatic — Draft Cavage + RFC 9421 + LD Signatures + Object Integrity Proofs |
| **Signature verification** | Only RSA-SHA256, no caching | Multi-algorithm, key caching, origin security (FEP-fe34) |
| **Key management** | Manual RSA-2048 in MongoDB | Automatic RSA + Ed25519 key pairs via `setKeyPairsDispatcher()` |
| **Activity delivery** | Manual `fetch()` to each inbox, no retry | Queue-based with retry, fan-out, shared inbox optimization |
| **WebFinger** | Manual JRD builder | Automatic from actor dispatcher + customizable links |
| **Content negotiation** | Manual `Accept` header check | Automatic via `federation.fetch()` |
| **Actor document** | Manual JSON builder | Type-safe `Person` object via `@fedify/vocab` |
| **Collection pagination** | None (dumps all items) | Cursor-based pagination via collection dispatchers |
| **Remote actor fetching** | Manual `fetch()` with no caching | `ctx.lookupObject()` with document loader caching |
| **NodeInfo** | Not implemented | Automatic via `setNodeInfoDispatcher()` |
| **Error handling** | Manual try/catch per route | Unified error handling via Fedify middleware |

## Architecture Decision: URL Structure

### The Problem

Currently the actor URL is `https://rmendes.net/` (the site root). Fedify requires `{identifier}` in URI templates (e.g., `/users/{identifier}`). Changing the actor URL breaks existing federation relationships because remote servers cache the actor ID.

### Recommended Approach: New URLs + Migration

Use conventional fediverse URL patterns under the plugin's mount path:

| Endpoint | Current URL | New URL |
|----------|-------------|---------|
| Actor | `https://rmendes.net/` | `https://rmendes.net/activitypub/users/{handle}` |
| Inbox | `/activitypub/inbox` | `/activitypub/users/{handle}/inbox` |
| Shared inbox | *(none)* | `/activitypub/inbox` |
| Outbox | `/activitypub/outbox` | `/activitypub/users/{handle}/outbox` |
| Followers | `/activitypub/followers` | `/activitypub/users/{handle}/followers` |
| Following | `/activitypub/following` | `/activitypub/users/{handle}/following` |

**Migration path:**
1. Set `alsoKnownAs: ["https://rmendes.net/"]` on the new actor
2. Keep content negotiation at `/` returning the actor document (redirects to canonical URL)
3. Keep old `/activitypub/inbox` accepting activities (301 to new path)
4. Send `Move` activity from old URL to new URL (triggers follower re-follow on Mastodon)

**Backward compatibility:**
- WebFinger returns the new canonical actor URL
- Content negotiation at root still serves the actor document for cached references
- Old inbox endpoint still accepts activities during transition
- `alsoKnownAs` tells remote servers these are the same identity

### Alternative: Keep Root URL (Fallback)

If URL migration is too risky, we can use Fedify for crypto/delivery/verification only, keeping manual actor document serving. This gives 70% of the benefits without URL changes. Discussed in Phase 1 notes.

## Architecture Decision: Express Integration

Since Indiekit plugins cannot inject app-level middleware (plugins only get route-level mounting), we **cannot** use `integrateFederation()` from `@fedify/express` directly.

**Approach:** Create the `Federation` object with `createFederation()`, configure all dispatchers and listeners, then call `federation.fetch()` inside Express route handlers. This is the recommended Fedify pattern for custom framework integrations.

```
Express Request → convert to standard Request → federation.fetch() → convert Response back
```

The `@fedify/express` package's `integrateFederation()` does exactly this internally, so we're not losing anything — just doing the conversion manually in each route handler.

## Architecture Decision: KvStore Adapter

Fedify requires a `KvStore` for key storage, follower data, and caching. We already use MongoDB. We need a thin adapter:

```js
class MongoKvStore {
  constructor(collection) { this.collection = collection; }
  async get(key) { ... }
  async set(key, value) { ... }
  async delete(key) { ... }
}
```

This reuses the existing MongoDB connection Indiekit already manages.

## Architecture Decision: Profile Management

Fedify's actor document is built from the dispatcher callback. Profile data (name, bio, avatar, links) needs to be:
1. **Stored** in a MongoDB collection (`ap_profile`)
2. **Editable** via an admin UI page at `/activitypub/admin/profile`
3. **Read** by the actor dispatcher to build the `Person` object

Profile fields map to Fedify's `Person` type:

| UI Field | MongoDB field | Fedify `Person` property | Notes |
|----------|---------------|--------------------------|-------|
| Display name | `name` | `name` | Plain text |
| Bio | `summary` | `summary` | HTML string |
| Avatar | `icon` | `icon` → `Image({ url, mediaType })` | URL or uploaded file |
| Header image | `image` | `image` → `Image({ url, mediaType })` | URL or uploaded file |
| Profile links | `attachments` | `attachments` → `PropertyValue[]` | Key-value pairs (like Mastodon custom fields) |
| Website URL | `url` | `url` | Typically the publication URL |
| Account migration | `alsoKnownAs` | `alsoKnownAs` | Array of previous URLs |

---

## Implementation Phases

### Phase 1 — Fedify Foundation (non-breaking)

**Goal:** Wire Fedify into the plugin without changing any external-facing URLs or behavior. Replace internal crypto with Fedify's signing/verification. This is the "safe" phase.

#### Task 1.1: Create MongoDB KvStore adapter

**File:** `lib/kv-store.js` (new)

Implement Fedify's `KvStore` interface backed by MongoDB. The adapter uses the existing `ap_keys` collection (or a new `ap_kv` collection) to store key-value pairs.

Methods: `get(key)`, `set(key, value)`, `delete(key)`. Keys are arrays of strings — serialize as a joined path (e.g., `["keypair", "rsa", "rick"]` → `"keypair/rsa/rick"`).

#### Task 1.2: Create Federation instance

**File:** `lib/federation-setup.js` (new)

Create the core `Federation` object using `createFederation()`:

```js
import { createFederation } from "@fedify/fedify";
import { MongoKvStore } from "./kv-store.js";

export function setupFederation(options) {
  const { kvCollection, publicationUrl, handle } = options;

  const federation = createFederation({
    kv: new MongoKvStore(kvCollection),
    // No queue for now — use InProcessMessageQueue later
  });

  // Configure dispatchers (Tasks 1.3-1.6)

  return federation;
}
```

#### Task 1.3: Set up actor dispatcher

Replace `lib/actor.js` (manual JSON builder) with Fedify's `setActorDispatcher()`.

```js
import { Person, Image, PropertyValue, Endpoints } from "@fedify/vocab";

federation.setActorDispatcher(
  "/activitypub/users/{identifier}",
  async (ctx, identifier) => {
    const profile = await getProfile(collections); // from MongoDB
    const keyPairs = await ctx.getActorKeyPairs(identifier);

    return new Person({
      id: ctx.getActorUri(identifier),
      preferredUsername: identifier,
      name: profile.name || identifier,
      summary: profile.summary || "",
      url: new URL(publicationUrl),
      inbox: ctx.getInboxUri(identifier),
      outbox: ctx.getOutboxUri(identifier),
      followers: ctx.getFollowersUri(identifier),
      following: ctx.getFollowingUri(identifier),
      endpoints: new Endpoints({
        sharedInbox: ctx.getInboxUri(),
      }),
      publicKey: keyPairs[0]?.cryptographicKey,
      assertionMethod: keyPairs[0]?.multikey,
      icon: profile.icon ? new Image({ url: new URL(profile.icon) }) : null,
      image: profile.image ? new Image({ url: new URL(profile.image) }) : null,
      published: profile.createdAt ? Temporal.Instant.from(profile.createdAt) : null,
      // alsoKnownAs for migration
      alsoKnownAs: profile.alsoKnownAs?.map(u => new URL(u)) || [],
    });
  }
);
```

#### Task 1.4: Set up key pairs dispatcher

Replace `lib/keys.js` (manual RSA generation) with Fedify's `setKeyPairsDispatcher()`.

Fedify generates both RSA (for HTTP Signatures) and Ed25519 (for Object Integrity Proofs) key pairs automatically. Keys are stored in the KvStore.

**Migration concern:** Existing RSA keys in `ap_keys` collection must be preserved. On first run, import the existing key pair into Fedify's KvStore format so signatures remain valid for remote servers that cached the old public key.

```js
federation
  .setActorDispatcher(...)
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    // Return existing keys from MongoDB, or let Fedify generate new ones
    return []; // Fedify auto-generates if empty
  });
```

**Key migration strategy:**
- Read existing RSA key from `ap_keys` collection
- Import it as the first key pair returned by the dispatcher
- Fedify will also generate an Ed25519 key for Object Integrity Proofs
- After migration, the RSA key ID stays `{actorUrl}#main-key`

#### Task 1.5: Set up inbox listeners

Replace `lib/inbox.js` (manual switch dispatch) with Fedify's typed inbox listeners:

```js
import { Follow, Undo, Like, Announce, Create, Delete, Move, Accept } from "@fedify/vocab";

federation
  .setInboxListeners("/activitypub/users/{identifier}/inbox", "/activitypub/inbox")
  .on(Follow, async (ctx, follow) => {
    // Auto-accept: send Accept back
    // Store follower in MongoDB
    const follower = await follow.getActor();
    // ... upsert to ap_followers
    await ctx.sendActivity(
      { identifier: handle },
      follower,
      new Accept({ actor: ctx.getActorUri(handle), object: follow }),
    );
  })
  .on(Undo, async (ctx, undo) => {
    const inner = await undo.getObject();
    if (inner instanceof Follow) {
      // Remove follower
    }
    // ... handle other Undo types
  })
  .on(Like, async (ctx, like) => { /* log activity */ })
  .on(Announce, async (ctx, announce) => { /* log activity */ })
  .on(Create, async (ctx, create) => { /* handle replies */ })
  .on(Delete, async (ctx, del) => { /* clean up */ })
  .on(Move, async (ctx, move) => { /* handle migration */ });
```

**Key benefit:** Fedify automatically verifies HTTP Signatures, LD Signatures, and Object Integrity Proofs on all incoming activities. No more manual `verifyHttpSignature()`.

#### Task 1.6: Set up collection dispatchers

Replace manual collection endpoints with Fedify's cursor-based pagination:

```js
federation.setFollowersDispatcher(
  "/activitypub/users/{identifier}/followers",
  async (ctx, identifier, cursor) => {
    const pageSize = 20;
    const skip = cursor ? parseInt(cursor) : 0;
    const docs = await collections.ap_followers
      .find().sort({ followedAt: -1 }).skip(skip).limit(pageSize).toArray();
    const total = await collections.ap_followers.countDocuments();

    return {
      items: docs.map(f => new URL(f.actorUrl)),
      nextCursor: skip + pageSize < total ? String(skip + pageSize) : null,
    };
  }
).setCounter(async (ctx, identifier) => {
  return await collections.ap_followers.countDocuments();
});

// Same pattern for following, outbox
```

#### Task 1.7: Replace outbound delivery with `ctx.sendActivity()`

Replace `sendSignedActivity()` (manual fetch + HTTP Signatures) with Fedify's queue-based delivery:

```js
// In syndicator.syndicate():
await ctx.sendActivity(
  { identifier: handle },
  "followers", // special keyword: deliver to all followers
  activity,
);
```

Fedify handles:
- HTTP Signature signing (Draft Cavage + RFC 9421)
- Linked Data Signatures
- Object Integrity Proofs
- Shared inbox optimization
- Retry on failure
- Rate limiting

#### Task 1.8: Wire federation.fetch() into Express routes

Update `index.js` to delegate to `federation.fetch()`:

```js
// In routesPublic:
router.all("/*", async (request, response, next) => {
  // Convert Express request to standard Request
  const url = new URL(request.originalUrl, `${request.protocol}://${request.get("host")}`);
  const standardRequest = new Request(url, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });

  const fedResponse = await federation.fetch(standardRequest, {
    contextData: { collections, publicationUrl },
  });

  if (fedResponse.status === 404) {
    return next(); // Fedify didn't handle it, pass to next middleware
  }

  // Convert Response back to Express
  response.status(fedResponse.status);
  for (const [key, value] of fedResponse.headers) {
    response.set(key, value);
  }
  const body = await fedResponse.text();
  response.send(body);
});
```

#### Task 1.9: WebFinger via Fedify

Remove `lib/webfinger.js`. Fedify handles WebFinger automatically when the actor dispatcher is configured. The `routesWellKnown` handler delegates to `federation.fetch()`:

```js
get routesWellKnown() {
  const router = express.Router();
  router.get("/webfinger", async (req, res, next) => {
    // Delegate to federation.fetch()
  });
  return router;
}
```

#### Task 1.10: NodeInfo support

Add `setNodeInfoDispatcher()` — this is new functionality the hand-rolled code doesn't have:

```js
federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (ctx) => ({
  software: {
    name: "indiekit",
    version: { major: 1, minor: 0, patch: 0 },
  },
  protocols: ["activitypub"],
  usage: {
    users: { total: 1, activeMonth: 1, activeHalfyear: 1 },
    localPosts: await collections.posts?.countDocuments() || 0,
    localComments: 0,
  },
}));
```

### Phase 2 — Profile Management UI

**Goal:** Allow the user to edit their ActivityPub profile from the Indiekit admin backend.

#### Task 2.1: Profile MongoDB collection

Add `ap_profile` collection. Store a single document:

```json
{
  "handle": "rick",
  "name": "Ricardo Mendes",
  "summary": "<p>IndieWeb enthusiast</p>",
  "icon": "https://rmendes.net/avatar.jpg",
  "image": "https://rmendes.net/header.jpg",
  "url": "https://rmendes.net/",
  "attachments": [
    { "name": "Website", "value": "<a href=\"https://rmendes.net\">rmendes.net</a>" },
    { "name": "GitHub", "value": "<a href=\"https://github.com/rmdes\">rmdes</a>" }
  ],
  "alsoKnownAs": ["https://mastodon.social/@rick"],
  "manuallyApprovesFollowers": false,
  "updatedAt": "2025-02-18T00:00:00.000Z"
}
```

Initialize from current config options (`options.actor`) on first run.

#### Task 2.2: Profile controller

**File:** `lib/controllers/profile.js` (new)

- `GET /activitypub/admin/profile` — render profile edit form
- `POST /activitypub/admin/profile` — save profile to MongoDB, clear cached actor document

#### Task 2.3: Profile edit template

**File:** `views/activitypub-profile.njk` (new)

Form fields:
- Display name (text input)
- Bio (textarea, HTML allowed)
- Avatar URL (text input, optionally file upload)
- Header image URL (text input, optionally file upload)
- Profile links (repeatable key-value pairs — like Mastodon's custom fields)
- Also Known As (text input for migration URL)
- Manually approves followers (checkbox)

Use existing Indiekit frontend components (from `@indiekit/frontend`).

#### Task 2.4: Wire profile into actor dispatcher

The actor dispatcher reads from the `ap_profile` collection instead of static config options. Profile changes are reflected immediately in the actor document — remote servers fetch fresh copies periodically.

#### Task 2.5: Send Update activity on profile change

When the user saves their profile, send an `Update(Person)` activity to all followers so their caches refresh:

```js
await ctx.sendActivity(
  { identifier: handle },
  "followers",
  new Update({
    actor: ctx.getActorUri(handle),
    object: await buildActorFromProfile(ctx, profile),
  }),
);
```

### Phase 3 — Cleanup and Polish

#### Task 3.1: Delete replaced files

Remove files that are fully replaced by Fedify:
- `lib/federation.js` — replaced by `lib/federation-setup.js` + Fedify
- `lib/actor.js` — replaced by actor dispatcher
- `lib/keys.js` — replaced by key pairs dispatcher
- `lib/webfinger.js` — replaced by Fedify automatic handling

#### Task 3.2: Keep and adapt

Files that are kept but adapted:
- `lib/jf2-to-as2.js` — KEEP. Converts Indiekit JF2 → AS2 for the outbox. Adapt to return Fedify `@fedify/vocab` objects instead of plain JSON.
- `lib/inbox.js` — DELETE (replaced by inbox listeners). Business logic moves into listener callbacks in `federation-setup.js`.
- `lib/migration.js` — KEEP. CSV import is independent of Fedify.
- `lib/controllers/*.js` — KEEP. Admin UI controllers are independent.

#### Task 3.3: Add message queue

For production reliability, add `InProcessMessageQueue` (or a persistent queue):

```js
import { InProcessMessageQueue } from "@fedify/fedify";

const federation = createFederation({
  kv: new MongoKvStore(kvCollection),
  queue: new InProcessMessageQueue(),
});
```

This enables background delivery with retry — activities that fail to deliver are retried automatically.

#### Task 3.4: Add logging

Configure LogTape for Fedify-specific logging:

```js
import { configure, getConsoleSink } from "@logtape/logtape";

await configure({
  sinks: { console: getConsoleSink() },
  loggers: [
    { category: "fedify", sinks: ["console"], lowestLevel: "info" },
  ],
});
```

#### Task 3.5: Update package.json

- Remove unused dependencies (if any — `@fedify/fedify` and `@fedify/express` are already declared)
- Add `@fedify/vocab` if not included in `@fedify/fedify`
- Add `@logtape/logtape` for logging
- Bump version to `0.2.0`

#### Task 3.6: Update admin navigation

Add "Profile" link to the dashboard navigation items:

```js
get navigationItems() {
  return {
    href: this.options.mountPath,
    text: "activitypub.title",
    requiresDatabase: true,
  };
}
```

Add profile card to dashboard showing current avatar, name, bio, follower count.

---

## Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `lib/kv-store.js` | NEW | MongoDB KvStore adapter for Fedify |
| `lib/federation-setup.js` | NEW | Fedify Federation creation + all dispatchers/listeners |
| `lib/controllers/profile.js` | NEW | Profile edit GET/POST controller |
| `views/activitypub-profile.njk` | NEW | Profile edit form template |
| `index.js` | MODIFY | Wire federation.fetch() into routes, add profile route |
| `lib/jf2-to-as2.js` | MODIFY | Return @fedify/vocab objects instead of plain JSON |
| `lib/federation.js` | DELETE | Replaced by federation-setup.js + Fedify |
| `lib/actor.js` | DELETE | Replaced by actor dispatcher |
| `lib/keys.js` | DELETE | Replaced by key pairs dispatcher |
| `lib/webfinger.js` | DELETE | Replaced by Fedify automatic handling |
| `lib/inbox.js` | DELETE | Logic moved to inbox listeners |
| `package.json` | MODIFY | Add @logtape/logtape, bump version |
| `locales/en.json` | MODIFY | Add profile-related i18n strings |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Existing followers can't verify signatures after key migration | Medium | High | Import existing RSA key into Fedify KvStore format first |
| Actor URL change breaks federation | High (if we change URLs) | High | alsoKnownAs + Move activity + keep old endpoints active |
| Fedify version incompatibility with Node 22 | Low | Medium | Already declared in package.json, should be tested |
| MongoDB KvStore adapter bugs | Medium | Medium | Test with real federation before deploying |
| Express ↔ standard Request conversion issues | Medium | Medium | Test content-type headers, body parsing, signature headers |

## Migration Checklist (Deploy Day)

1. [ ] Backup MongoDB (`ap_followers`, `ap_following`, `ap_activities`, `ap_keys`)
2. [ ] Export existing RSA key pair from `ap_keys`
3. [ ] Deploy new version
4. [ ] Verify WebFinger returns correct actor URL
5. [ ] Verify actor document is served correctly
6. [ ] Test receiving a Follow from a test account
7. [ ] Test sending a post to followers
8. [ ] Verify existing followers can still see posts
9. [ ] If URL changed: verify alsoKnownAs is set, send Move activity
10. [ ] Monitor logs for signature verification failures
