# @rmdes/indiekit-endpoint-activitypub

ActivityPub federation endpoint for [Indiekit](https://getindiekit.com). Makes your IndieWeb site a full fediverse actor — discoverable, followable, and interactive from Mastodon, Misskey, Pixelfed, and any ActivityPub-compatible platform.

## Features

**Federation**
- Full ActivityPub actor with WebFinger, NodeInfo, HTTP Signatures, and Object Integrity Proofs (Ed25519)
- Outbox syndication — posts created via Micropub are automatically delivered to followers
- Inbox processing — receives follows, likes, boosts, replies, mentions, deletes, and account moves
- Content negotiation — ActivityPub clients requesting your site get JSON-LD; browsers get HTML
- Reply delivery — replies are addressed to and delivered directly to the original post's author
- Shared inbox support with collection sync (FEP-8fcf)
- Configurable actor type (Person, Service, Organization, Group)

**Reader**
- Timeline view showing posts from followed accounts
- Notifications for likes, boosts, follows, mentions, and replies
- Compose form with dual-path posting (quick AP reply or Micropub blog post)
- Native interactions (like, boost, reply, follow/unfollow from the reader)
- Remote actor profile pages
- Content warnings and sensitive content handling
- Media display (images, video, audio)
- Configurable timeline retention

**Moderation**
- Mute actors or keywords
- Block actors (also removes from followers)
- All moderation actions available from the reader UI

**Mastodon Migration**
- Import following/followers lists from Mastodon CSV exports
- Set `alsoKnownAs` alias for account Move verification
- Batch re-follow processor — gradually sends Follow activities to imported accounts
- Progress tracking with pause/resume controls

**Admin UI**
- Dashboard with follower/following counts and recent activity
- Profile editor (name, bio, avatar, header, profile links with rel="me" verification)
- Pinned posts (featured collection)
- Featured tags (hashtag collection)
- Activity log (inbound/outbound)
- Follower and following lists with source tracking

## Requirements

- [Indiekit](https://getindiekit.com) v1.0.0-beta.25+
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
| Reader | `/activitypub/admin/reader` | Timeline from followed accounts |
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

## MongoDB Collections

The plugin creates these collections automatically:

| Collection | Description |
|---|---|
| `ap_followers` | Accounts following your actor |
| `ap_following` | Accounts you follow |
| `ap_activities` | Activity log with automatic TTL cleanup |
| `ap_keys` | RSA and Ed25519 key pairs for HTTP Signatures |
| `ap_kv` | Fedify key-value store and batch job state |
| `ap_profile` | Actor profile (single document) |
| `ap_featured` | Pinned/featured posts |
| `ap_featured_tags` | Featured hashtags |
| `ap_timeline` | Reader timeline items from followed accounts |
| `ap_notifications` | Interaction notifications |
| `ap_muted` | Muted actors and keywords |
| `ap_blocked` | Blocked actors |
| `ap_interactions` | Per-post like/boost tracking |

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

## Known Limitations

- **No automated tests** — Manual testing against real fediverse servers
- **Single actor** — One fediverse identity per Indiekit instance
- **No Authorized Fetch enforcement** — Disabled due to Fedify's current limitation with authenticated outgoing fetches (causes infinite loops with servers that require it)
- **No image upload in reader** — Compose form is text-only
- **In-process queue without Redis** — Activities may be lost on restart

## License

MIT

## Author

[Ricardo Mendes](https://rmendes.net) ([@rick@rmendes.net](https://rmendes.net))
