/**
 * Create MongoDB indexes for all ActivityPub collections.
 * Idempotent — safe to run on every startup.
 * @module init-indexes
 *
 * @param {object} collections - MongoDB collections object
 * @param {object} options
 * @param {number} options.activityRetentionDays - TTL for ap_activities (0 = forever)
 * @param {number} options.notificationRetentionDays - TTL for notifications (0 = forever)
 */
export function createIndexes(collections, options) {
  const { activityRetentionDays, notificationRetentionDays } = options;

  // Create indexes — wrapped in try-catch because collection references
  // may be undefined if MongoDB hasn't finished connecting yet.
  // Indexes are idempotent; they'll be created on next successful startup.
  try {
    // TTL index for activity cleanup (MongoDB handles expiry automatically)
    const retentionDays = activityRetentionDays;
    if (retentionDays > 0) {
      collections.ap_activities.createIndex(
        { receivedAt: 1 },
        { expireAfterSeconds: retentionDays * 86_400 },
      );
    }

    // Performance indexes for inbox handlers and batch refollow
    collections.ap_followers.createIndex(
      { actorUrl: 1 },
      { unique: true, background: true },
    );
    collections.ap_following.createIndex(
      { actorUrl: 1 },
      { unique: true, background: true },
    );
    collections.ap_following.createIndex(
      { source: 1 },
      { background: true },
    );
    collections.ap_activities.createIndex(
      { objectUrl: 1 },
      { background: true },
    );
    collections.ap_activities.createIndex(
      { type: 1, actorUrl: 1, objectUrl: 1 },
      { background: true },
    );

    // Reader indexes (timeline, notifications, moderation, interactions)
    collections.ap_timeline.createIndex(
      { uid: 1 },
      { unique: true, background: true },
    );
    collections.ap_timeline.createIndex(
      { published: -1 },
      { background: true },
    );
    collections.ap_timeline.createIndex(
      { "author.url": 1 },
      { background: true },
    );
    collections.ap_timeline.createIndex(
      { type: 1, published: -1 },
      { background: true },
    );

    collections.ap_notifications.createIndex(
      { uid: 1 },
      { unique: true, background: true },
    );
    collections.ap_notifications.createIndex(
      { published: -1 },
      { background: true },
    );
    collections.ap_notifications.createIndex(
      { read: 1 },
      { background: true },
    );
    collections.ap_notifications.createIndex(
      { type: 1, published: -1 },
      { background: true },
    );

    // TTL index for notification cleanup
    const notifRetention = notificationRetentionDays;
    if (notifRetention > 0) {
      collections.ap_notifications.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: notifRetention * 86_400 },
      );
    }

    // Message indexes
    collections.ap_messages.createIndex(
      { uid: 1 },
      { unique: true, background: true },
    );
    collections.ap_messages.createIndex(
      { published: -1 },
      { background: true },
    );
    collections.ap_messages.createIndex(
      { read: 1 },
      { background: true },
    );
    collections.ap_messages.createIndex(
      { conversationId: 1, published: -1 },
      { background: true },
    );
    collections.ap_messages.createIndex(
      { direction: 1 },
      { background: true },
    );
    // TTL index for message cleanup (reuse notification retention)
    if (notifRetention > 0) {
      collections.ap_messages.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: notifRetention * 86_400 },
      );
    }

    // Muted collection — sparse unique indexes (allow multiple null values)
    collections.ap_muted
      .dropIndex("url_1")
      .catch(() => {})
      .then(() =>
        collections.ap_muted.createIndex(
          { url: 1 },
          { unique: true, sparse: true, background: true },
        ),
      )
      .catch(() => {});
    collections.ap_muted
      .dropIndex("keyword_1")
      .catch(() => {})
      .then(() =>
        collections.ap_muted.createIndex(
          { keyword: 1 },
          { unique: true, sparse: true, background: true },
        ),
      )
      .catch(() => {});

    collections.ap_blocked.createIndex(
      { url: 1 },
      { unique: true, background: true },
    );

    collections.ap_interactions.createIndex(
      { objectUrl: 1, type: 1 },
      { unique: true, background: true },
    );
    collections.ap_interactions.createIndex(
      { type: 1 },
      { background: true },
    );

    // Followed hashtags — unique on tag (case-insensitive via normalization at write time)
    collections.ap_followed_tags.createIndex(
      { tag: 1 },
      { unique: true, background: true },
    );

    // Tag filtering index on timeline
    collections.ap_timeline.createIndex(
      { category: 1, published: -1 },
      { background: true },
    );

    // Explore tab indexes
    // Compound unique on (type, domain, scope, hashtag) prevents duplicate tabs.
    // ALL insertions must explicitly set all four fields (unused fields = null)
    // because MongoDB treats missing fields differently from null in unique indexes.
    collections.ap_explore_tabs.createIndex(
      { type: 1, domain: 1, scope: 1, hashtag: 1 },
      { unique: true, background: true },
    );
    // Order index for efficient sorting of tab bar
    collections.ap_explore_tabs.createIndex(
      { order: 1 },
      { background: true },
    );

    // ap_reports indexes
    if (notifRetention > 0) {
      collections.ap_reports.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: notifRetention * 86_400 },
      );
    }
    collections.ap_reports.createIndex(
      { reporterUrl: 1 },
      { background: true },
    );
    collections.ap_reports.createIndex(
      { reportedUrls: 1 },
      { background: true },
    );
    // Pending follow requests — unique on actorUrl
    collections.ap_pending_follows.createIndex(
      { actorUrl: 1 },
      { unique: true, background: true },
    );
    collections.ap_pending_follows.createIndex(
      { requestedAt: -1 },
      { background: true },
    );
    // Server-level blocks
    collections.ap_blocked_servers.createIndex(
      { hostname: 1 },
      { unique: true, background: true },
    );
    // Key freshness tracking
    collections.ap_key_freshness.createIndex(
      { actorUrl: 1 },
      { unique: true, background: true },
    );

    // Inbox queue indexes
    collections.ap_inbox_queue.createIndex(
      { status: 1, receivedAt: 1 },
      { background: true },
    );
    // TTL: auto-prune completed items after 24h
    collections.ap_inbox_queue.createIndex(
      { processedAt: 1 },
      { expireAfterSeconds: 86_400, background: true },
    );

    // Mastodon Client API indexes
    collections.ap_oauth_apps.createIndex(
      { clientId: 1 },
      { unique: true, background: true },
    );
    collections.ap_oauth_tokens.createIndex(
      { accessToken: 1 },
      { unique: true, sparse: true, background: true },
    );
    collections.ap_oauth_tokens.createIndex(
      { code: 1 },
      { unique: true, sparse: true, background: true },
    );
    collections.ap_markers.createIndex(
      { userId: 1, timeline: 1 },
      { unique: true, background: true },
    );

    // Tombstone indexes (FEP-4f05)
    collections.ap_tombstones?.createIndex(
      { url: 1 },
      { unique: true, background: true },
    );
  } catch {
    // Index creation failed — collections not yet available.
    // Indexes already exist from previous startups; non-fatal.
  }
}
