/**
 * Fixture seeder for Stage 0's test net.
 *
 * The dataset is not arbitrary — it is constructed so that every defect in the
 * plan's §1 register becomes observable:
 *
 *   AP-D2  notifications carrying `read` vs `dismissed`
 *   AP-D3  timeline items with and without `read`
 *   AP-D4  a reply chain deeper than the reader's maxDepth=5
 *   AP-D5  one item per visibility value
 *   AP-D7  an item whose `published` order and insertion (`_id`) order disagree
 *   AP-D8  a pending follow request
 *   AP-D9  ap_muted holding BOTH an account mute (url) and a keyword mute
 *
 * Insertion order is load-bearing for AP-D7. Do not reorder `TIMELINE` without
 * re-reading the note on LATE_ARRIVAL below.
 */

const AUTHOR_A = {
  name: "Alice",
  url: "https://remote.example/users/alice",
  photo: "https://remote.example/avatars/alice.png",
  handle: "@alice@remote.example",
};

const AUTHOR_B = {
  name: "Bob",
  url: "https://other.example/users/bob",
  photo: "https://other.example/avatars/bob.png",
  handle: "@bob@other.example",
};

const LOCAL_AUTHOR = {
  name: "Rick",
  url: "https://local.example/",
  photo: "https://local.example/avatar.png",
  handle: "@rick@local.example",
};

/** Build a timeline item with sane defaults. */
function item(overrides = {}) {
  const uid = overrides.uid || `https://remote.example/notes/${overrides.n ?? 0}`;

  return {
    uid,
    url: uid,
    type: "note",
    content: { text: "hello", html: "<p>hello</p>" },
    summary: "",
    sensitive: false,
    published: "2026-08-01T12:00:00.000Z",
    author: AUTHOR_A,
    category: [],
    mentions: [],
    photo: [],
    video: [],
    audio: [],
    inReplyTo: null,
    visibility: "public",
    read: false,
    isContext: false,
    createdAt: "2026-08-01T12:00:00.000Z",
    readBy: [],
    ...overrides,
  };
}

/**
 * Timeline fixtures, in INSERTION order.
 *
 * The last entry (LATE_ARRIVAL) has the OLDEST `published` but the NEWEST
 * `_id`, because MongoDB assigns ObjectIds in insertion order and the ObjectId
 * timestamp prefix is what the Mastodon lane paginates on. That single item is
 * what makes AP-D7 observable: the two lanes place it at opposite ends.
 */
export const TIMELINE = [
  item({ n: 1, published: "2026-08-01T09:00:00.000Z", visibility: "public" }),
  item({ n: 2, published: "2026-08-01T10:00:00.000Z", visibility: "unlisted" }),
  item({ n: 3, published: "2026-08-01T11:00:00.000Z", visibility: "private" }),
  item({ n: 4, published: "2026-08-01T12:00:00.000Z", visibility: "direct" }),

  // Read/unread split — AP-D3
  item({ n: 5, published: "2026-08-01T13:00:00.000Z", read: true }),

  // An article and a boost, for tab/type filtering
  item({
    n: 6,
    published: "2026-08-01T14:00:00.000Z",
    type: "article",
    name: "An article",
  }),
  item({
    n: 7,
    published: "2026-08-01T15:00:00.000Z",
    type: "boost",
    boostedBy: LOCAL_AUTHOR,
    boostedAt: "2026-08-01T15:00:00.000Z",
    originalUrl: "https://remote.example/notes/1",
  }),

  // Hashtag item — mixed case, to exercise case-insensitive tag matching
  item({ n: 8, published: "2026-08-01T16:00:00.000Z", category: ["ActivityPub"] }),

  // Reply chain 7 deep — deeper than the reader's maxDepth=5 (AP-D4).
  // 9 is the root; 10..15 are successive replies.
  item({ n: 9, published: "2026-08-02T09:00:00.000Z" }),
  ...Array.from({ length: 6 }, (_, i) =>
    item({
      n: 10 + i,
      published: `2026-08-02T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
      inReplyTo: `https://remote.example/notes/${9 + i}`,
      author: AUTHOR_B,
    }),
  ),

  // Context-only ancestor — must never appear in a timeline
  item({
    n: 16,
    published: "2026-07-20T09:00:00.000Z",
    isContext: true,
  }),

  // Legacy shape: non-reply stored with inReplyTo as "" rather than null.
  // MongoDB treats {inReplyTo: null} as matching missing OR null, but not "",
  // so this row is what distinguishes the two lanes' reply predicates.
  item({ n: 17, published: "2026-08-02T20:00:00.000Z", inReplyTo: "" }),

  // LATE ARRIVAL — inserted last (newest _id), published first (oldest date).
  // AP-D7 made observable.
  //
  // MUST be authored by AUTHOR_A. AUTHOR_B is account-muted by the MUTED
  // fixture, and both lanes apply moderation — so a B-authored late arrival is
  // filtered from both, and an ordering comparison silently becomes -1 === -1.
  item({
    n: 18,
    uid: "https://remote.example/notes/late",
    published: "2026-07-01T08:00:00.000Z",
    author: AUTHOR_A,
  }),
];

export const NOTIFICATIONS = [
  // Untouched
  {
    uid: "https://remote.example/likes/1",
    type: "like",
    actorUrl: AUTHOR_A.url,
    actorName: AUTHOR_A.name,
    objectUrl: "https://local.example/posts/1",
    published: "2026-08-01T09:00:00.000Z",
    read: false,
  },
  // Read via the reader lane only — Mastodon still shows it (AP-D2)
  {
    uid: "https://remote.example/likes/2",
    type: "like",
    actorUrl: AUTHOR_A.url,
    actorName: AUTHOR_A.name,
    objectUrl: "https://local.example/posts/2",
    published: "2026-08-01T10:00:00.000Z",
    read: true,
  },
  // Dismissed via the Mastodon lane only — the reader still shows it (AP-D2)
  {
    uid: "https://remote.example/boosts/1",
    type: "boost",
    actorUrl: AUTHOR_B.url,
    actorName: AUTHOR_B.name,
    objectUrl: "https://local.example/posts/3",
    published: "2026-08-01T11:00:00.000Z",
    read: false,
    dismissed: true,
  },
  {
    uid: "https://remote.example/follows/1",
    type: "follow",
    actorUrl: AUTHOR_B.url,
    actorName: AUTHOR_B.name,
    published: "2026-08-01T12:00:00.000Z",
    read: false,
  },
];

export const INTERACTIONS = [
  {
    objectUrl: "https://remote.example/notes/1",
    type: "like",
    activityId: "https://local.example/activitypub/likes/aaa",
    createdAt: "2026-08-01T09:30:00.000Z",
  },
  {
    objectUrl: "https://remote.example/notes/2",
    type: "boost",
    activityId: "https://local.example/activitypub/boosts/bbb",
    createdAt: "2026-08-01T10:30:00.000Z",
  },
  {
    objectUrl: "https://remote.example/notes/6",
    type: "bookmark",
    createdAt: "2026-08-01T14:30:00.000Z",
  },
];

/**
 * ap_muted holds BOTH shapes. This is the fixture that makes AP-D9 visible:
 * the reader lists the account mute, GET /api/v1/mutes returns [].
 */
export const MUTED = [
  { url: AUTHOR_B.url, createdAt: "2026-08-01T00:00:00.000Z" },
  { keyword: "spoiler", createdAt: "2026-08-01T00:00:00.000Z" },
];

export const BLOCKED = [
  { url: "https://bad.example/users/mallory", createdAt: "2026-08-01T00:00:00.000Z" },
];

export const BLOCKED_SERVERS = [
  { hostname: "blocked.example", createdAt: "2026-08-01T00:00:00.000Z" },
];

export const FOLLOWED_TAGS = [
  { tag: "activitypub", createdAt: "2026-08-01T00:00:00.000Z" },
  { tag: "indieweb", createdAt: "2026-08-01T00:00:00.000Z" },
];

export const PENDING_FOLLOWS = [
  {
    actorUrl: AUTHOR_B.url,
    name: AUTHOR_B.name,
    handle: AUTHOR_B.handle,
    avatar: AUTHOR_B.photo,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
];

/**
 * Direct messages. conversationId is the other party's actor URL, so these two
 * form ONE conversation with AUTHOR_A plus one with AUTHOR_B.
 */
export const MESSAGES = [
  {
    uid: "https://remote.example/dm/1",
    actorUrl: AUTHOR_A.url,
    actorName: AUTHOR_A.name,
    actorPhoto: AUTHOR_A.photo,
    actorHandle: AUTHOR_A.handle,
    content: { text: "hello there", html: "<p>hello there</p>" },
    inReplyTo: null,
    conversationId: AUTHOR_A.url,
    direction: "inbound",
    published: "2026-08-01T09:00:00.000Z",
    createdAt: "2026-08-01T09:00:00.000Z",
    read: false,
  },
  {
    uid: "https://local.example/dm/2",
    actorUrl: AUTHOR_A.url,
    actorName: AUTHOR_A.name,
    actorPhoto: AUTHOR_A.photo,
    actorHandle: AUTHOR_A.handle,
    content: { text: "hi back", html: "<p>hi back</p>" },
    inReplyTo: "https://remote.example/dm/1",
    conversationId: AUTHOR_A.url,
    direction: "outbound",
    published: "2026-08-01T09:05:00.000Z",
    createdAt: "2026-08-01T09:05:00.000Z",
    read: true,
  },
  {
    uid: "https://remote.example/dm/3",
    actorUrl: AUTHOR_B.url,
    actorName: AUTHOR_B.name,
    actorPhoto: AUTHOR_B.photo,
    actorHandle: AUTHOR_B.handle,
    content: { text: "separate thread", html: "<p>separate thread</p>" },
    inReplyTo: null,
    conversationId: AUTHOR_B.url,
    direction: "inbound",
    published: "2026-08-02T10:00:00.000Z",
    createdAt: "2026-08-02T10:00:00.000Z",
    read: false,
  },
];

export const PROFILE = {
  name: "Rick",
  summary: "Test profile",
  url: "https://local.example/",
  icon: "https://local.example/avatar.png",
  manuallyApprovesFollowers: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

/**
 * A non-expiring access token, matching the shape index.js repairs to.
 *
 * `scopes` is an ARRAY, not a space-delimited `scope` string —
 * lib/mastodon/middleware/scope-required.js reads `token.scopes`, and
 * routes/oauth.js persists the parsed array. Getting this wrong yields a
 * uniform 403 across every scope-guarded endpoint.
 */
export const OAUTH_TOKEN = {
  accessToken: "test-access-token",
  clientId: "test-client",
  scopes: ["read", "write", "follow", "push"],
  createdAt: "2026-08-01T00:00:00.000Z",
};

/**
 * Seed every collection. Insertion order within ap_timeline is preserved,
 * which AP-D7 depends on.
 *
 * By default the Stage 2 migrations run afterwards, so fixtures reflect a
 * MIGRATED database — which is what any real deployment looks like once
 * v4 ships. Pass `{ migrate: false }` to get the pre-migration shape, which
 * the migration tests themselves need.
 *
 * @param {Record<string, import("mongodb").Collection>} collections
 * @param {object} [options]
 * @param {boolean} [options.migrate=true]
 */
export async function seed(collections, { migrate = true } = {}) {
  // Sequential, not Promise.all — ObjectId order must follow array order.
  for (const doc of TIMELINE) {
    await collections.ap_timeline.insertOne({ ...doc });
  }

  await collections.ap_notifications.insertMany(
    NOTIFICATIONS.map((d) => ({ ...d })),
  );
  await collections.ap_interactions.insertMany(INTERACTIONS.map((d) => ({ ...d })));
  await collections.ap_muted.insertMany(MUTED.map((d) => ({ ...d })));
  await collections.ap_blocked.insertMany(BLOCKED.map((d) => ({ ...d })));
  await collections.ap_blocked_servers.insertMany(
    BLOCKED_SERVERS.map((d) => ({ ...d })),
  );
  await collections.ap_followed_tags.insertMany(FOLLOWED_TAGS.map((d) => ({ ...d })));
  await collections.ap_pending_follows.insertMany(
    PENDING_FOLLOWS.map((d) => ({ ...d })),
  );
  await collections.ap_messages.insertMany(MESSAGES.map((d) => ({ ...d })));
  await collections.ap_profile.insertOne({ ...PROFILE });
  await collections.ap_oauth_tokens.insertOne({ ...OAUTH_TOKEN });

  if (migrate) {
    // Dynamic import keeps this helper usable by the migration tests, which
    // need to seed the pre-migration shape and run the steps themselves.
    const { ensureReceivedAtIndexes, backfillReceivedAt, backfillReadAt } =
      await import("../../lib/migrations/single-lane-core.js");

    await ensureReceivedAtIndexes(collections);
    await backfillReceivedAt(collections);
    await backfillReadAt(collections);
  }
}

export const AUTHORS = { AUTHOR_A, AUTHOR_B, LOCAL_AUTHOR };
