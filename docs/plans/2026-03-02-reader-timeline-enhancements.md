# Reader Timeline Enhancements

## Features

### 1. New Posts Detection (Reader timeline)

30-second background poll checks for items newer than the top-most visible item's `published` date.

- **API**: `GET /admin/reader/api/timeline/count-new?after={isoDate}&tab={tab}` returns `{ count: N }`
- **UI**: Sticky banner at top of timeline: "N new posts — Load"
- Clicking loads new items via existing `api/timeline` with `after=` param, prepends to timeline
- Banner disappears after loading; polling continues from newest item's date
- Explore tabs excluded (external instance APIs don't support "since" queries efficiently)

### 2. Mark As Read on Scroll

IntersectionObserver watches each `.ap-card` at 50% threshold.

- When card is 50% visible, its `uid` is batched client-side
- Every 5 seconds, batch flushes via `POST /admin/reader/api/timeline/mark-read` with `{ uids: [...] }`
- Server sets `{ read: true }` on matching `ap_timeline` docs
- **Visual**: `.ap-card--read` class applies `opacity: 0.7`, set immediately on observe
- **Filter toggle**: "Show unread only" in tab bar adds `?unread=1` — server filters `{ read: { $ne: true } }`
- `unreadCount` in template reflects actual unread items

### 3. Infinite Scroll + Load More

Already implemented via `apInfiniteScroll` and `apExploreScroll` Alpine components. No changes needed.

## Files to Modify

| File | Change |
|------|--------|
| `lib/controllers/api-timeline.js` | New `countNewController` and `markReadController` endpoints |
| `lib/storage/timeline.js` | `countNewItems()` and `markItemsRead()` functions |
| `lib/controllers/reader.js` | Pass `unread` filter param, compute `unreadCount` from DB |
| `index.js` | Register new API routes |
| `assets/reader-infinite-scroll.js` | New `apNewPostsBanner` Alpine component + read tracking observer |
| `views/activitypub-reader.njk` | New posts banner markup, unread toggle, read class on cards |
| `assets/reader.css` | `.ap-card--read`, banner styles, unread toggle styles |
