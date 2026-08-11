/**
 * In-memory MongoDB harness for Stage 0's test net.
 *
 * The two lanes (lib/controllers/* and lib/mastodon/routes/*) diverge in query
 * construction, not in pure functions — so parity has to be asserted against a
 * real MongoDB, not a stub. mongodb-memory-server gives us one per suite with
 * no external service.
 *
 * Two collection shapes are needed because the codebase uses both:
 *   - plain object  — index.js builds `this._collections = { ap_timeline, … }`
 *   - Map           — controllers read `application.collections.get("ap_timeline")`
 *
 * `withMongo()` returns both views over the same database.
 */
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Every collection the plugin registers, so a harness database looks like a
 * real one. Kept in sync with index.js `init()`.
 */
export const COLLECTION_NAMES = [
  "ap_followers",
  "ap_following",
  "ap_activities",
  "ap_keys",
  "ap_kv",
  "ap_profile",
  "ap_featured",
  "ap_featured_tags",
  "ap_timeline",
  "ap_notifications",
  "ap_muted",
  "ap_blocked",
  "ap_interactions",
  "ap_followed_tags",
  "ap_messages",
  "ap_explore_tabs",
  "ap_reports",
  "ap_pending_follows",
  "ap_blocked_servers",
  "ap_key_freshness",
  "ap_inbox_queue",
  "ap_oauth_apps",
  "ap_oauth_tokens",
  "ap_markers",
  "ap_tombstones",
  "ap_media",
  "ap_status_edits",
  "ap_idempotency",
  "ap_filters",
  "ap_filter_keywords",
  "ap_settings",
  "posts",
];

/**
 * Start an in-memory MongoDB and return handles plus a teardown function.
 *
 * @returns {Promise<{
 *   collections: Record<string, import("mongodb").Collection>,
 *   collectionMap: Map<string, import("mongodb").Collection>,
 *   db: import("mongodb").Db,
 *   reset: () => Promise<void>,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function withMongo() {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  await client.connect();

  const db = client.db("ap-test");

  const collections = {};
  const collectionMap = new Map();

  for (const name of COLLECTION_NAMES) {
    const collection = db.collection(name);
    collections[name] = collection;
    collectionMap.set(name, collection);
  }

  return {
    collections,
    collectionMap,
    db,

    /** Empty every collection, leaving the harness reusable between tests. */
    async reset() {
      await Promise.all(
        COLLECTION_NAMES.map((name) => db.collection(name).deleteMany({})),
      );
    },

    async stop() {
      await client.close();
      await server.stop();
    },
  };
}
