# Federation Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all spec compliance issues found during the Fedify docs audit — persistent Ed25519 keys, proper `assertionMethods`, Redis message queue, Reject listener, database indexes, and storeRawActivities wiring.

**Architecture:** Changes are isolated to the plugin's `lib/` layer (federation-setup.js, inbox-listeners.js, activity-log.js) plus package.json for the new `@fedify/redis` dependency. The plugin accepts an optional `redisUrl` from Indiekit config; when present, it uses `RedisMessageQueue` instead of `InProcessMessageQueue`. Ed25519 keys are generated once and persisted to `ap_keys` as JWK. Cloudron deployment config is updated to pass through the Redis URL.

**Tech Stack:** `@fedify/fedify` ^1.10.0, `@fedify/redis` (new), `ioredis` (new), MongoDB (existing)

---

### Task 1: Persist Ed25519 key pair to database

**Files:**
- Modify: `lib/federation-setup.js` (lines 139-167, setKeyPairsDispatcher)

**Context:** Currently `generateCryptoKeyPair("Ed25519")` is called on every request, producing a new key pair each time. Remote servers fetching the actor to verify an Object Integrity Proof get a different public key than the one used to sign — causing silent verification failures. The Fedify docs say: "generate key pairs for each actor when the actor is created" and store them persistently using `exportJwk()`/`importJwk()`.

**Step 1: Add `exportJwk` and `importJwk` to imports**

At the top of `federation-setup.js`, add to the existing import:

```javascript
import {
  Endpoints,
  Image,
  InProcessMessageQueue,
  Person,
  PropertyValue,
  createFederation,
  exportJwk,           // ADD
  generateCryptoKeyPair,
  importJwk,           // ADD
  importSpki,
} from "@fedify/fedify";
```

**Step 2: Rewrite `setKeyPairsDispatcher` to persist Ed25519**

Replace the entire `.setKeyPairsDispatcher(async (ctx, identifier) => { ... })` block (lines 139-167) with:

```javascript
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    if (identifier !== handle) return [];

    const keyPairs = [];

    // --- Legacy RSA key pair (HTTP Signatures) ---
    const legacyKey = await collections.ap_keys.findOne({ type: "rsa" });
    // Fall back to old schema (no type field) for backward compat
    const rsaDoc = legacyKey || await collections.ap_keys.findOne({
      publicKeyPem: { $exists: true },
    });

    if (rsaDoc?.publicKeyPem && rsaDoc?.privateKeyPem) {
      try {
        const publicKey = await importSpki(rsaDoc.publicKeyPem);
        const privateKey = await importPkcs8Pem(rsaDoc.privateKeyPem);
        keyPairs.push({ publicKey, privateKey });
      } catch {
        console.warn("[ActivityPub] Could not import legacy RSA keys");
      }
    }

    // --- Ed25519 key pair (Object Integrity Proofs) ---
    // Load from DB or generate + persist on first use
    let ed25519Doc = await collections.ap_keys.findOne({ type: "ed25519" });

    if (ed25519Doc?.publicKeyJwk && ed25519Doc?.privateKeyJwk) {
      try {
        const publicKey = await importJwk(ed25519Doc.publicKeyJwk, "public");
        const privateKey = await importJwk(ed25519Doc.privateKeyJwk, "private");
        keyPairs.push({ publicKey, privateKey });
      } catch (error) {
        console.warn(
          "[ActivityPub] Could not import Ed25519 keys, regenerating:",
          error.message,
        );
        ed25519Doc = null; // Force regeneration below
      }
    }

    if (!ed25519Doc) {
      try {
        const ed25519 = await generateCryptoKeyPair("Ed25519");
        await collections.ap_keys.insertOne({
          type: "ed25519",
          publicKeyJwk: await exportJwk(ed25519.publicKey),
          privateKeyJwk: await exportJwk(ed25519.privateKey),
          createdAt: new Date().toISOString(),
        });
        keyPairs.push(ed25519);
        console.info("[ActivityPub] Generated and persisted Ed25519 key pair");
      } catch (error) {
        console.warn(
          "[ActivityPub] Could not generate Ed25519 key pair:",
          error.message,
        );
      }
    }

    return keyPairs;
  });
```

**Step 3: Verify**

Run: `fedify lookup https://rmendes.net/activitypub/users/rick`

Expected: Actor still resolves with `publicKey` and `assertionMethod` visible. Restart the app and re-run — the same key should be returned (verify by comparing the key IDs between requests).

**Step 4: Commit**

```
feat(keys): persist Ed25519 key pair to ap_keys collection

Previously generated a new Ed25519 key pair on every request,
causing Object Integrity Proof verification failures on remote
servers. Now generates once and stores as JWK in MongoDB.
```

---

### Task 2: Fix `assertionMethods` (plural) on actor

**Files:**
- Modify: `lib/federation-setup.js` (lines 113-117, actor dispatcher)

**Context:** The actor currently sets `assertionMethod` (singular) with only the first key's multikey. The Fedify docs specify `assertionMethods` (plural array) containing ALL multikey instances — typically one per key pair (RSA + Ed25519).

**Step 1: Replace singular with plural**

In the actor dispatcher, find:

```javascript
if (keyPairs.length > 0) {
  personOptions.publicKey = keyPairs[0].cryptographicKey;
  personOptions.assertionMethod = keyPairs[0].multikey;
}
```

Replace with:

```javascript
if (keyPairs.length > 0) {
  personOptions.publicKey = keyPairs[0].cryptographicKey;
  personOptions.assertionMethods = keyPairs.map((k) => k.multikey);
}
```

**Step 2: Verify**

Run: `fedify lookup https://rmendes.net/activitypub/users/rick`

Expected: Actor output shows `assertionMethods` (plural) with entries for both RSA and Ed25519 keys.

**Step 3: Commit**

```
fix(actor): use assertionMethods (plural) per Fedify spec

Exposes all key pair multikeys (RSA + Ed25519) instead of only
the first. Required for proper Object Integrity Proof verification.
```

---

### Task 3: Add `@fedify/redis` dependency and `redisUrl` config option

**Files:**
- Modify: `package.json`
- Modify: `index.js` (constructor, init method)

**Context:** The plugin needs to accept an optional `redisUrl` from Indiekit config and pass it through to federation setup. When not provided, behavior remains unchanged (InProcessMessageQueue).

**Step 1: Add dependencies**

```bash
cd /home/rick/code/indiekit-dev/indiekit-endpoint-activitypub
npm install @fedify/redis ioredis
```

This adds both packages to `package.json` `dependencies`.

**Step 2: Add `redisUrl` to defaults in `index.js`**

Find the `defaults` object (line 32):

```javascript
const defaults = {
  mountPath: "/activitypub",
  actor: {
    handle: "rick",
    name: "",
    summary: "",
    icon: "",
  },
  checked: true,
  alsoKnownAs: "",
  activityRetentionDays: 90,
  storeRawActivities: false,
};
```

Add `redisUrl`:

```javascript
const defaults = {
  mountPath: "/activitypub",
  actor: {
    handle: "rick",
    name: "",
    summary: "",
    icon: "",
  },
  checked: true,
  alsoKnownAs: "",
  activityRetentionDays: 90,
  storeRawActivities: false,
  redisUrl: "",
};
```

**Step 3: Pass `redisUrl` to `setupFederation` in `init()`**

In the `init(Indiekit)` method, find the `setupFederation` call (around line 626):

```javascript
const { federation } = setupFederation({
  collections: this._collections,
  mountPath: this.options.mountPath,
  handle: this.options.actor.handle,
  storeRawActivities: this.options.storeRawActivities,
});
```

Add `redisUrl`:

```javascript
const { federation } = setupFederation({
  collections: this._collections,
  mountPath: this.options.mountPath,
  handle: this.options.actor.handle,
  storeRawActivities: this.options.storeRawActivities,
  redisUrl: this.options.redisUrl,
});
```

**Step 4: Commit**

```
feat(redis): add @fedify/redis dependency and redisUrl config option

Plugin now accepts optional redisUrl from Indiekit config.
Plumbing only — actual Redis usage is wired in the next commit.
```

---

### Task 4: Use `RedisMessageQueue` when `redisUrl` is provided

**Files:**
- Modify: `lib/federation-setup.js` (imports and `createFederation` call)

**Context:** Replace `InProcessMessageQueue` with `RedisMessageQueue` when Redis is available. The `RedisMessageQueue` constructor takes a factory function `() => new Redis(url)` so Fedify can create connections as needed.

**Step 1: Update imports and federation creation**

At the top of `federation-setup.js`, keep `InProcessMessageQueue` in the import (used as fallback) and add a conditional import approach. Replace the `createFederation` block:

Find:

```javascript
const federation = createFederation({
  kv: new MongoKvStore(collections.ap_kv),
  queue: new InProcessMessageQueue(),
});
```

Replace with:

```javascript
let queue;
if (redisUrl) {
  const { RedisMessageQueue } = await import("@fedify/redis");
  const Redis = (await import("ioredis")).default;
  queue = new RedisMessageQueue(() => new Redis(redisUrl));
  console.info("[ActivityPub] Using Redis message queue");
} else {
  queue = new InProcessMessageQueue();
  console.warn(
    "[ActivityPub] Using in-process message queue (not recommended for production)",
  );
}

const federation = createFederation({
  kv: new MongoKvStore(collections.ap_kv),
  queue,
});
```

**Step 2: Add `redisUrl` to the destructured options**

Find:

```javascript
const {
  collections,
  mountPath,
  handle,
  storeRawActivities = false,
} = options;
```

Replace with:

```javascript
const {
  collections,
  mountPath,
  handle,
  storeRawActivities = false,
  redisUrl = "",
} = options;
```

**Step 3: Verify locally**

Without Redis: Plugin should log the "in-process" warning and work as before.
With Redis: Plugin should log "Using Redis message queue".

**Step 4: Commit**

```
feat(redis): use RedisMessageQueue when redisUrl is configured

Falls back to InProcessMessageQueue when Redis is not available.
Redis provides persistent, retry-capable delivery that survives
process restarts — critical for reliable federation.
```

---

### Task 5: Add `Reject` inbox listener

**Files:**
- Modify: `lib/inbox-listeners.js`

**Context:** When a remote server rejects our Follow request, the `ap_following` entry stays as `refollow:sent` forever. A `Reject` listener should mark it as rejected and clean up.

**Step 1: Add `Reject` to imports**

Find:

```javascript
import {
  Accept,
  Add,
  Announce,
  Block,
  Create,
  Delete,
  Follow,
  Like,
  Move,
  Note,
  Remove,
  Undo,
  Update,
} from "@fedify/fedify";
```

Add `Reject`:

```javascript
import {
  Accept,
  Add,
  Announce,
  Block,
  Create,
  Delete,
  Follow,
  Like,
  Move,
  Note,
  Reject,
  Remove,
  Undo,
  Update,
} from "@fedify/fedify";
```

**Step 2: Add the listener after the `Accept` handler**

After the `.on(Accept, ...)` block (around line 162), add:

```javascript
    .on(Reject, async (ctx, reject) => {
      const actorObj = await reject.getActor();
      const actorUrl = actorObj?.id?.href || "";
      if (!actorUrl) return;

      // Mark rejected follow in ap_following
      const result = await collections.ap_following.findOneAndUpdate(
        {
          actorUrl,
          source: { $in: ["refollow:sent", "microsub-reader"] },
        },
        {
          $set: {
            source: "rejected",
            rejectedAt: new Date().toISOString(),
          },
        },
        { returnDocument: "after" },
      );

      if (result) {
        const actorName = result.name || result.handle || actorUrl;
        await logActivity(collections, storeRawActivities, {
          direction: "inbound",
          type: "Reject(Follow)",
          actorUrl,
          actorName,
          summary: `${actorName} rejected our Follow`,
        });
      }
    })
```

**Step 3: Verify**

Check the plugin loads without errors. The Reject handler will activate when a remote server sends a Reject activity in response to a Follow.

**Step 4: Commit**

```
feat(inbox): add Reject listener for rejected Follow requests

Marks ap_following entries as "rejected" instead of leaving them
stuck in "refollow:sent" state indefinitely.
```

---

### Task 6: Add database indexes for query performance

**Files:**
- Modify: `index.js` (in the `init()` method, after the TTL index creation)

**Context:** With 830+ followers and 2500+ following, unindexed queries on `actorUrl`, `source`, and `objectUrl` are doing full collection scans. MongoDB uses these fields for lookups in every inbox activity handler.

**Step 1: Add indexes after the existing TTL index block**

Find the TTL index block in `init()` (around line 612-618):

```javascript
if (retentionDays > 0) {
  this._collections.ap_activities.createIndex(
    { receivedAt: 1 },
    { expireAfterSeconds: retentionDays * 86_400 },
  );
}
```

Add immediately after:

```javascript
// Performance indexes for inbox handlers and batch refollow
this._collections.ap_followers.createIndex(
  { actorUrl: 1 },
  { unique: true, background: true },
);
this._collections.ap_following.createIndex(
  { actorUrl: 1 },
  { unique: true, background: true },
);
this._collections.ap_following.createIndex(
  { source: 1 },
  { background: true },
);
this._collections.ap_activities.createIndex(
  { objectUrl: 1 },
  { background: true },
);
this._collections.ap_activities.createIndex(
  { type: 1, actorUrl: 1, objectUrl: 1 },
  { background: true },
);
```

**Step 2: Verify**

These are idempotent — `createIndex` on an existing index is a no-op. After deploying, verify with:

```bash
cloudron exec --app rmendes.net -- bash -c 'mongosh "$CLOUDRON_MONGODB_URL" --quiet --eval "
  db.ap_followers.getIndexes().forEach(i => print(JSON.stringify(i.key)));
  db.ap_following.getIndexes().forEach(i => print(JSON.stringify(i.key)));
  db.ap_activities.getIndexes().forEach(i => print(JSON.stringify(i.key)));
"'
```

**Step 3: Commit**

```
perf(db): add indexes for ap_followers, ap_following, ap_activities

Prevents collection scans on actorUrl lookups (every inbox
activity), source queries (batch refollow), and objectUrl
deletions (Delete handler). Critical at 830+ followers.
```

---

### Task 7: Wire up `storeRawActivities` flag in activity logging

**Files:**
- Modify: `lib/activity-log.js`
- Modify: `lib/inbox-listeners.js` (the local `logActivity` wrapper)

**Context:** The `storeRawActivities` config option is accepted and threaded through to inbox listeners, but the local `logActivity` wrapper silently ignores it. The `logActivityShared` function in `activity-log.js` doesn't accept a raw JSON parameter either.

**Step 1: Read the current `activity-log.js`**

Current file:

```javascript
export async function logActivity(collection, record) {
  await collection.insertOne({
    ...record,
    receivedAt: new Date().toISOString(),
  });
}
```

**Step 2: Add optional `rawJson` field support**

Replace:

```javascript
export async function logActivity(collection, record) {
  await collection.insertOne({
    ...record,
    receivedAt: new Date().toISOString(),
  });
}
```

With:

```javascript
/**
 * Log an activity to the ap_activities collection.
 *
 * @param {import("mongodb").Collection} collection
 * @param {object} record - Activity fields (direction, type, actorUrl, etc.)
 * @param {object} [options]
 * @param {object} [options.rawJson] - Full raw JSON to store (when storeRawActivities is on)
 */
export async function logActivity(collection, record, options = {}) {
  const doc = {
    ...record,
    receivedAt: new Date().toISOString(),
  };
  if (options.rawJson) {
    doc.rawJson = options.rawJson;
  }
  await collection.insertOne(doc);
}
```

**Step 3: Update the wrapper in `inbox-listeners.js`**

Find:

```javascript
async function logActivity(collections, storeRaw, record) {
  await logActivityShared(collections.ap_activities, record);
}
```

Replace with:

```javascript
async function logActivity(collections, storeRaw, record, rawJson) {
  await logActivityShared(
    collections.ap_activities,
    record,
    storeRaw && rawJson ? { rawJson } : {},
  );
}
```

**Step 4: Commit**

```
fix(log): wire storeRawActivities flag through to activity log

The config option was accepted but silently ignored. Now passes
raw JSON to the activity log when enabled.
```

---

### Task 8: Update Cloudron deployment config to pass `redisUrl`

**Files:**
- Modify: `/home/rick/code/indiekit-dev/indiekit-cloudron/indiekit.config.js.rmendes` (ActivityPub section)
- Modify: `/home/rick/code/indiekit-dev/indiekit-cloudron/indiekit.config.js.template` (ActivityPub section)
- Modify: `/home/rick/code/indiekit-dev/indiekit-cloudron/Dockerfile` (bump plugin version)

**Context:** The Cloudron container already has `CLOUDRON_REDIS_URL` available. The plugin needs it passed through as `redisUrl` in its config section.

**Step 1: Update `.rmendes` config**

In the ActivityPub config block, add `redisUrl`:

```javascript
  "@rmdes/indiekit-endpoint-activitypub": {
    mountPath: "/activitypub",
    actor: {
      handle: "rick",
      name: "Ricardo Mendes",
      summary: "Personal website of Ricardo Mendes",
      icon: "https://rmendes.net/images/user/avatar.jpg",
    },
    checked: true,
    alsoKnownAs: "",
    activityRetentionDays: 90,
    storeRawActivities: false,
    redisUrl: process.env.CLOUDRON_REDIS_URL || "",
  },
```

**Step 2: Update `.template` config**

Add the same `redisUrl` line to the template's ActivityPub section (if present), or add a full ActivityPub config block.

**Step 3: Bump plugin version in Dockerfile**

Update the `npm install` line in the Dockerfile to reference the new version once published.

**Step 4: Commit (in indiekit-cloudron repo)**

```
feat: pass Redis URL to ActivityPub endpoint for persistent queue

Cloudron provides CLOUDRON_REDIS_URL from the Redis addon.
The ActivityPub plugin uses it for RedisMessageQueue, which
survives process restarts unlike InProcessMessageQueue.
```

---

### Task 9: Bump plugin version and publish

**Files:**
- Modify: `package.json` (version field)

**Step 1: Bump version**

```bash
cd /home/rick/code/indiekit-dev/indiekit-endpoint-activitypub
# Bump from 1.0.20 to 1.0.21
```

Update `"version": "1.0.21"` in package.json.

**Step 2: Commit all changes**

```
chore: bump version to 1.0.21
```

**Step 3: Push and publish**

```bash
git push origin main
```

Then **STOP — user must run `npm publish`** (requires OTP).

---

### Task 10: Deploy and run federation test suite

**Step 1: After user confirms publish, update Dockerfile and deploy**

```bash
cd /home/rick/code/indiekit-dev/indiekit-cloudron
cloudron build --no-cache && cloudron update --app rmendes.net --no-backup
```

**Step 2: Verify Redis is connected**

```bash
cloudron logs -f --app rmendes.net | grep -i "redis\|message queue"
```

Expected: `[ActivityPub] Using Redis message queue`

**Step 3: Run the test suite**

```bash
cd /home/rick/code/indiekit-dev/activitypub-tests
./run-all.sh
```

Expected: 12/12 passing.

**Step 4: Verify Ed25519 key persistence**

```bash
cloudron exec --app rmendes.net -- bash -c 'mongosh "$CLOUDRON_MONGODB_URL" --quiet --eval "
  db.ap_keys.find({ type: \"ed25519\" }).toArray()
"'
```

Expected: One document with `publicKeyJwk` and `privateKeyJwk` fields.

**Step 5: Verify indexes**

```bash
cloudron exec --app rmendes.net -- bash -c 'mongosh "$CLOUDRON_MONGODB_URL" --quiet --eval "
  print(\"ap_followers indexes:\");
  db.ap_followers.getIndexes().forEach(i => print(\"  \" + JSON.stringify(i.key)));
  print(\"ap_following indexes:\");
  db.ap_following.getIndexes().forEach(i => print(\"  \" + JSON.stringify(i.key)));
  print(\"ap_activities indexes:\");
  db.ap_activities.getIndexes().forEach(i => print(\"  \" + JSON.stringify(i.key)));
"'
```

Expected: Indexes on `actorUrl`, `source`, `objectUrl`, and the compound `{ type, actorUrl, objectUrl }`.
