# Explore Page Tabbed Redesign Implementation Plan

Created: 2026-02-28
Status: VERIFIED
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
> **Worktree:** No — working directly on current branch

## Summary

**Goal:** Replace the cramped deck/column layout on the ActivityPub explore page with a full-width tabbed design. Three tab types: Search (always first, not removable), Instance (pinned instances with local/federated badge), and Hashtag (aggregated across all pinned instances). New `ap_explore_tabs` collection replaces `ap_decks` (clean start, no migration).

**Architecture:** Server-rendered tab navigation with Alpine.js for tab content loading. Each tab loads its own timeline via the existing explore API (instance tabs) or a new hashtag aggregation API (hashtag tabs). The tab bar is a horizontal scrollable row with the Search tab always first, followed by user-ordered Instance and Hashtag tabs. Tab reordering uses server-side PATCH endpoint. No limit on tab count.

**Tech Stack:** Express routes (Node.js), Nunjucks templates, Alpine.js 3.x for client-side interactivity, MongoDB for `ap_explore_tabs` collection, Mastodon API v1 for timelines.

## Scope

### In Scope

- Replace deck grid layout with full-width tab navigation
- New `ap_explore_tabs` collection with schema: `{ type, domain?, scope?, hashtag?, order, addedAt }`
- Search tab: existing instance search + optional hashtag field switching between `/timelines/public` and `/timelines/tag/{hashtag}`
- Instance tabs: full-width timeline with local/federated scope badge
- Hashtag tabs: parallel queries across all pinned instances, merge by date, dedup by post URL
- Tab CRUD API: add, remove, reorder
- Tab reordering UI: up/down arrow buttons (simpler, more accessible than drag-and-drop)
- Each tab loads independently with infinite scroll
- Replace deck-related Alpine.js components with tab-based ones
- Replace deck CSS with tab CSS
- Update i18n locale strings
- Note: The responsive CSS fix (`width: 100%` + `box-sizing: border-box` on `.ap-lookup__input` and `.ap-explore-form__input`) was already committed prior to this plan — no action needed

### Out of Scope

- Drag-and-drop tab reordering (deferred — up/down arrows first, DnD can be added later)
- Per-instance hashtag filter within instance tabs (deferred per user decision)
- Migration of old `ap_decks` data (clean start per user decision)
- Changes to the main reader timeline, tag timeline, or notifications

## Prerequisites

- Node.js >= 22 (already in place)
- `@rmdes/indiekit-endpoint-activitypub` repo at version 2.0.36
- MongoDB with existing ActivityPub collections

## Context for Implementer

> This section is critical for cross-session continuity.

- **Patterns to follow:**
  - Controller pattern: `lib/controllers/explore.js` — exports factory functions `controllerName(mountPath)` returning `async (request, response, next) => { ... }`
  - API JSON endpoint pattern: `exploreApiController()` at `explore.js:260` — renders partials server-side via `request.app.render()`, returns `{ html, maxId }`
  - CSRF validation pattern: `lib/controllers/decks.js:45` — `validateToken(request)` from `../csrf.js`
  - SSRF prevention: `validateInstance()` at `explore.js:22` — validates hostnames, blocks private IPs
  - Alpine.js registration: `reader-decks.js:9` — `document.addEventListener("alpine:init", () => { Alpine.data(...) })`
  - CSS conventions: Uses Indiekit theme custom properties (`--color-on-background`, `--color-primary`, etc.)
  - Tab styling: Existing `.ap-tabs` / `.ap-tab` / `.ap-tab--active` CSS at `reader.css:91-134` (reused and extended)

- **Conventions:**
  - ESM modules (`import`/`export`)
  - Dates stored as ISO 8601 strings: `new Date().toISOString()`
  - Template variables must avoid collisions with Nunjucks macro names imported in `default.njk` (e.g., `tag` collides with the `tag` macro — use `hashtag` instead)
  - Express 5: No `redirect("back")` — use explicit paths
  - sanitize-html for any remote content displayed in HTML

- **Key files:**
  - `index.js` — Plugin entry; collection registration (line 888), route registration (line 239-246), index creation (line 1036-1039)
  - `lib/controllers/explore.js` — Current explore controller (405 lines) with `exploreController`, `exploreApiController`, `instanceSearchApiController`, `instanceCheckApiController`, `popularAccountsApiController`, and helper `mapMastodonStatusToItem`
  - `lib/controllers/decks.js` — Current deck CRUD (137 lines): `listDecksController`, `addDeckController`, `removeDeckController`
  - `views/activitypub-explore.njk` — Current explore template (218 lines) with Search tab and Decks tab
  - `assets/reader-decks.js` — Alpine components: `apDeckToggle`, `apDeckColumn` (212 lines)
  - `assets/reader-infinite-scroll.js` — Alpine components: `apExploreScroll`, `apInfiniteScroll` (183 lines)
  - `assets/reader-autocomplete.js` — Alpine components: `apInstanceSearch`, `apPopularAccounts` (214 lines)
  - `assets/reader.css` — All styles (2248 lines); deck styles at lines 2063-2248
  - `locales/en.json` — i18n strings; explore section at line 229

- **Gotchas:**
  - Template variable `tag` is shadowed by Nunjucks macro from `default.njk` — always use `hashtag` in template context
  - The `.ap-tabs` CSS class already exists and is used for the current Search/Decks tab bar — it will be extended for the new design
  - `reader-infinite-scroll.js` contains `apExploreScroll` (for explore page) AND `apInfiniteScroll` (for main reader timeline) — only the former is being replaced
  - The `ap_kv` collection is used for FediDB caching — not related to deck/tab storage
  - Mastodon hashtag timeline API: `GET /api/v1/timelines/tag/{hashtag}?local=true|false&limit=20&max_id=X` — public, no auth needed

- **Domain context:**
  - The explore page lets users browse public timelines from remote Mastodon-compatible instances
  - Instance tabs pin specific instances so users don't re-search each time
  - Hashtag tabs aggregate a hashtag across ALL pinned instances in parallel (e.g., #indieweb from mastodon.social + fosstodon.org + ...)
  - The Search tab is the entry point for discovering new instances + one-off browsing

## Runtime Environment

- **Start command:** Deployed via Cloudron (`/app/pkg/start.sh`); locally via `node --loader` or through Indiekit dev server
- **Port:** 8080 (Indiekit), 3000 (nginx proxy)
- **Deploy path:** `indiekit-cloudron/Dockerfile` installs from npm, `cloudron build --no-cache && cloudron update --app rmendes.net --no-backup`
- **Health check:** `curl -s https://rmendes.net/activitypub/ | head -20` (should return dashboard HTML)
- **Restart procedure:** `cloudron restart --app rmendes.net` or full rebuild cycle

## Feature Inventory — Files Being Replaced

This is a **refactoring task** — the deck system is being replaced by a tab system.

### Files Being Replaced

| Old File | Functions/Features | Mapped to Task |
| --- | --- | --- |
| `lib/controllers/decks.js` | `listDecksController()`, `addDeckController()`, `removeDeckController()` — CRUD for `ap_decks` | Task 2 (replaced by tab CRUD) |
| `lib/controllers/explore.js` | `exploreController()` — renders explore page with deck data | Task 3, Task 5 |
| `lib/controllers/explore.js` | `exploreApiController()` — AJAX infinite scroll for single instance | Task 5, Task 6 |
| `lib/controllers/explore.js` | `instanceSearchApiController()` — FediDB autocomplete | Task 3 (kept as-is) |
| `lib/controllers/explore.js` | `instanceCheckApiController()` — timeline support check | Task 3 (kept as-is) |
| `lib/controllers/explore.js` | `popularAccountsApiController()` — popular accounts API | Task 3 (kept as-is) |
| `lib/controllers/explore.js` | `validateInstance()` — SSRF-safe hostname validation | Task 2 (reused as-is) |
| `lib/controllers/explore.js` | `mapMastodonStatusToItem()` — status-to-timeline-item mapping | Task 5, Task 6 (reused as-is) |
| `views/activitypub-explore.njk` | Search form + autocomplete | Task 3 |
| `views/activitypub-explore.njk` | Deck grid + deck columns | Task 4 |
| `views/activitypub-explore.njk` | Instance timeline + infinite scroll | Task 5 |
| `assets/reader-decks.js` | `apDeckToggle` — star/add-to-deck button | Task 4 (replaced by "Pin" button) |
| `assets/reader-decks.js` | `apDeckColumn` — individual deck column with infinite scroll | Task 5 (replaced by tab panel) |
| `assets/reader-infinite-scroll.js` | `apExploreScroll` — explore page infinite scroll | Task 5 (replaced by tab-scoped scroll) |
| `assets/reader-infinite-scroll.js` | `apInfiniteScroll` — main reader timeline scroll | NOT TOUCHED (kept as-is) |
| `assets/reader-autocomplete.js` | `apInstanceSearch` — instance autocomplete | Task 3 (extended with hashtag field) |
| `assets/reader-autocomplete.js` | `apPopularAccounts` — popular account autocomplete | NOT TOUCHED (kept as-is) |
| `assets/reader.css` | `.ap-deck-*` styles (lines 2063-2248) | Task 4 (replaced by tab styles) |
| `assets/reader.css` | `.ap-explore-deck-toggle` styles (lines 2063-2103) | Task 4 (replaced by "Pin" styles) |
| `assets/reader.css` | `.ap-tabs` styles (lines 91-134) | Task 4 (extended for dynamic tabs) |
| `locales/en.json` | `explore.tabs.*`, `explore.deck.*` strings | Task 3 (updated strings) |
| `index.js` | `ap_decks` collection registration + indexes (line 888, 1036-1039) | Task 1 |
| `index.js` | Deck route registration (lines 244-246) | Task 2 |

### Feature Mapping Verification

- [x] All old files listed above
- [x] All functions/classes identified
- [x] Every feature has a task number
- [x] No features accidentally omitted

## Progress Tracking

**MANDATORY: Update this checklist as tasks complete. Change `[ ]` to `[x]`.**

- [x] Task 1: Collection setup — `ap_explore_tabs` replaces `ap_decks`
- [x] Task 2: Tab CRUD API — add, remove, reorder endpoints
- [x] Task 3: Search tab — form with hashtag field, updated template
- [x] Task 4: Tab bar UI — dynamic tabs with scope badges, reordering, pin button
- [x] Task 5: Instance tab panel — full-width timeline with infinite scroll
- [x] Task 6: Hashtag tab panel — cross-instance aggregation
- [x] Task 7: Cleanup — remove old deck code, update CSS, update locales

**Total Tasks:** 7 | **Completed:** 7 | **Remaining:** 0

## Implementation Tasks

### Task 1: Collection Setup — `ap_explore_tabs` Replaces `ap_decks`

**Objective:** Register the new `ap_explore_tabs` MongoDB collection with proper indexes, replacing `ap_decks`. Clean start — no migration of old data.

**Dependencies:** None

**Files:**

- Modify: `index.js` — Replace `ap_decks` collection registration with `ap_explore_tabs`, update `this._collections`, create indexes

**Key Decisions / Notes:**

- Schema: `{ type: "instance"|"hashtag", domain?: string, scope?: "local"|"federated", hashtag?: string, order: number, addedAt: string (ISO 8601) }`
- Indexes: single unique compound index on `(type, domain, scope, hashtag)`. **CRITICAL: All insertions MUST explicitly set ALL four fields** — instance tabs set `hashtag: null`, hashtag tabs set `domain: null, scope: null`. MongoDB treats missing fields and explicit `null` differently in compound indexes, so omitting a field would bypass the uniqueness constraint and allow duplicates.
- `order` field: integer, used for user-controlled tab ordering. New tabs get `order = max(existing orders) + 1`. Use `findOneAndUpdate` with `sort: { order: -1 }` to atomically determine the next order value (prevents race conditions on concurrent additions).
- No limit on tab count (removed the `MAX_DECKS = 8` restriction)
- Remove old `ap_decks` references from collection registration and `this._collections`

**Definition of Done:**

- [ ] `ap_explore_tabs` collection registered in `index.js` (replacing `ap_decks`)
- [ ] `this._collections` includes `ap_explore_tabs` instead of `ap_decks`
- [ ] Unique compound index on `(type, domain, scope, hashtag)` created
- [ ] Index on `order` field created for efficient sorting
- [ ] Old `ap_decks` references completely removed from `index.js`

**Verify:**

- `grep -r "ap_decks" index.js` returns nothing
- `grep "ap_explore_tabs" index.js` shows collection registration, `this._collections`, and index creation

---

### Task 2: Tab CRUD API — Add, Remove, Reorder Endpoints

**Objective:** Create the tab management API replacing the old deck CRUD. Supports adding instance tabs, adding hashtag tabs, removing any tab, and reordering tabs.

**Dependencies:** Task 1

**Files:**

- Create: `lib/controllers/tabs.js` — New tab CRUD controller with `listTabsController`, `addTabController`, `removeTabController`, `reorderTabsController`, and `validateHashtag()` helper
- Modify: `index.js` — Replace deck route imports and registrations with tab routes
- Delete: `lib/controllers/decks.js` — Deleted here when replaced by tabs.js (Task 7 only verifies it's gone)

**Key Decisions / Notes:**

- `POST /admin/reader/api/tabs` — Add tab. Body: `{ type: "instance"|"hashtag", domain?, scope?, hashtag? }`. Validates domain via `validateInstance()`, validates hashtag via `validateHashtag()`. Auto-assigns `order = max(existing) + 1`. **CRITICAL: Insertions MUST explicitly set all four indexed fields** — instance tabs: `{ type, domain, scope, hashtag: null, order, addedAt }`, hashtag tabs: `{ type, domain: null, scope: null, hashtag, order, addedAt }`.
- `POST /admin/reader/api/tabs/remove` — Remove tab. Body: `{ type, domain?, scope?, hashtag? }`. After removal, re-compacts order numbers to avoid gaps.
- `PATCH /admin/reader/api/tabs/reorder` — Reorder tabs. Body: `{ tabIds: [id1, id2, ...] }` — array of MongoDB `_id` strings in desired order. Sets `order = index` for each.
- `GET /admin/reader/api/tabs` — List all tabs sorted by `order` ascending.
- **`validateHashtag()` helper** (new, alongside `validateInstance()`): (1) Strip leading `#` characters, (2) Reject if empty after stripping, (3) Validate against `/^[\w]+$/` (alphanumeric + underscore only — matching Mastodon's hashtag rules), (4) Enforce max length of 100 chars. Call this in the add-tab endpoint for hashtag tabs AND in the hashtag explore endpoint (Task 6).
- All POST/PATCH endpoints require CSRF token validation via `validateToken(request)`.
- All domain inputs validated via `validateInstance()` (imported from explore.js).
- All tab routes registered in the `routes` getter (not `routesPublic`) to ensure IndieAuth authentication protects them.
- Reuse the existing CSRF and validation patterns from `decks.js`.

**Definition of Done:**

- [ ] `GET /admin/reader/api/tabs` returns all tabs sorted by order
- [ ] `POST /admin/reader/api/tabs` with `{ type: "instance", domain: "mastodon.social", scope: "local" }` creates a tab
- [ ] `POST /admin/reader/api/tabs` with `{ type: "hashtag", hashtag: "indieweb" }` creates a tab
- [ ] Duplicate tabs rejected with 409
- [ ] `POST /admin/reader/api/tabs/remove` removes tab and re-compacts order
- [ ] `PATCH /admin/reader/api/tabs/reorder` updates order for all specified tabs
- [ ] `validateHashtag()` helper rejects empty, non-alphanumeric, and >100 char hashtags
- [ ] Hashtag tabs insert with explicit `domain: null, scope: null`; instance tabs insert with explicit `hashtag: null`
- [ ] CSRF validation on all mutating endpoints
- [ ] SSRF validation on domain inputs
- [ ] Old deck routes removed from `index.js`
- [ ] `lib/controllers/decks.js` deleted

**Verify:**

- `grep -r "ap_decks\|decks.js" index.js` returns nothing
- `grep "tabs.js\|api/tabs" index.js` shows new routes

---

### Task 3: Search Tab — Form with Hashtag Field

**Objective:** Update the Search tab's search form to add an optional hashtag field. When a hashtag is entered, the API call switches from `/timelines/public` to `/timelines/tag/{hashtag}`. Update both `exploreController()` (initial page load) and `exploreApiController()` (AJAX infinite scroll) to handle the `hashtag` query param.

**Dependencies:** Task 1

**Files:**

- Modify: `views/activitypub-explore.njk` — Add hashtag input field to search form (within the Search tab content section only; leave the tab nav bar unchanged — Task 4 replaces it entirely). Pass hashtag value to infinite scroll data attributes.
- Modify: `lib/controllers/explore.js` — Add `hashtag` query param handling in BOTH `exploreController()` AND `exploreApiController()`; change API URL construction to use `/timelines/tag/{hashtag}` when hashtag is provided; update template variables (remove deck references). Validate hashtag via `validateHashtag()` from `tabs.js`.
- Modify: `assets/reader-autocomplete.js` — Extend `apInstanceSearch` to handle hashtag field state
- Modify: `locales/en.json` — Update explore locale strings (remove deck strings, add tab/hashtag strings)

**Key Decisions / Notes:**

- The hashtag field is a plain text input next to the instance field. When filled, the explore API fetches `/api/v1/timelines/tag/{encodedHashtag}?local=true|false` instead of `/api/v1/timelines/public`
- The `hashtag` parameter is stripped of leading `#` and URL-encoded
- **Both `exploreController` and `exploreApiController` must handle the hashtag param** — without this, infinite scroll on search tab with hashtag would revert to the public timeline after the first page
- The template's infinite scroll data attributes must pass the hashtag value so the AJAX endpoint receives it on subsequent pages
- The Search tab is always the first tab and cannot be removed
- **Do NOT modify the tab navigation bar** (lines 14-24 of template) — leave it as-is in this task; Task 4 replaces it entirely with the dynamic tab bar. Only modify the Search tab content section.
- Keep `instanceSearchApiController`, `instanceCheckApiController`, `popularAccountsApiController` unchanged in explore.js
- Remove `decks`, `deckCount`, `isInDeck` from the controller's template variables

**Definition of Done:**

- [ ] Search form has an optional hashtag text input field
- [ ] When hashtag is provided, `exploreController` fetches from `/timelines/tag/{hashtag}` instead of `/timelines/public`
- [ ] When hashtag is provided, `exploreApiController` also fetches from `/timelines/tag/{hashtag}` (infinite scroll stays in hashtag mode)
- [ ] Hashtag is validated via `validateHashtag()`, URL-encoded, and stripped of leading `#`
- [ ] Scope radio buttons still work with hashtag mode
- [ ] Infinite scroll data attributes pass the hashtag value to the AJAX endpoint
- [ ] i18n strings updated: deck strings removed, hashtag placeholder string added

**Verify:**

- Open explore page — Search tab renders with instance + hashtag fields
- Submit with instance `mastodon.social` + hashtag `indieweb` — results load from tag timeline
- Scroll down — infinite scroll continues fetching from tag timeline (not reverting to public)
- Submit with instance only (no hashtag) — results load from public timeline (unchanged behavior)

---

### Task 4: Tab Bar UI — Dynamic Tabs with Scope Badges, Reordering, Pin Button

**Objective:** Build the dynamic tab bar that shows Search + user-added Instance/Hashtag tabs. Each Instance tab shows domain + scope badge. Each Hashtag tab shows `#tag`. Tabs have close buttons and up/down reorder arrows. Replace the star/deck-toggle button with a "Pin as tab" button on search results. Add UI for creating hashtag tabs.

**Dependencies:** Task 2, Task 3

**Files:**

- Modify: `views/activitypub-explore.njk` — Replace static Search/Decks tab nav with dynamic tab bar; add "Pin as tab" button for search results; add "Add hashtag tab" UI
- Create: `assets/reader-tabs.js` — Alpine.js component `apExploreTabs` for tab management (switching, adding, removing, reordering). **Guard init with DOM check:** `if (!document.querySelector('.ap-explore-tabs')) return;` — since the script loads on all reader pages via the shared layout, this prevents console errors on non-explore pages.
- Modify: `assets/reader.css` — Remove `.ap-deck-*` styles, add `.ap-explore-tab-*` styles for dynamic tabs with badges, controls, and overflow handling
- Modify: `views/layouts/ap-reader.njk` — Replace `reader-decks.js` script tag with `reader-tabs.js`. IMPORTANT: `reader-tabs.js` must load BEFORE the Alpine CDN script (same `defer` pattern as existing component scripts) since it registers Alpine data components via the `alpine:init` event.

**Key Decisions / Notes:**

- Tab bar: horizontal scrollable row. Search tab first (no close button, no reorder). All other tabs (Instance + Hashtag) sorted by `order` field **regardless of type** — tabs are freely interleaved, not grouped by type.
- Instance tab label: `{domain}` with a colored scope badge (local = blue, federated = purple) — reuse `.ap-deck-column__scope-badge` colors
- Hashtag tab label: `#{hashtag}`
- Each non-Search tab has: close button (×) and up/down arrows for reordering
- "Pin as tab" button replaces the star/deck-toggle button in search results area
- **"Add hashtag tab" UI:** A `+#` button at the end of the tab bar opens a small inline form (text input + confirm button) to add a hashtag tab. On submit, calls `POST /admin/reader/api/tabs` with `{ type: "hashtag", hashtag: value }`. The new tab appears in the tab bar with `#{hashtag}` label.
- When a tab is clicked, the tab content area switches to show that tab's timeline (Alpine.js handles visibility)
- The `apExploreTabs` Alpine component manages: active tab state, tab list from server, add/remove/reorder API calls
- Tab data is loaded via `GET /admin/reader/api/tabs` on page init
- **Reorder debouncing:** Debounce reorder API calls (500ms after last arrow click) so rapid clicks batch into a single request. This prevents race conditions from rapid successive clicks.
- **Tab bar overflow:** When tabs overflow horizontally, show fade gradients at edges to indicate scrollable content. Tab labels use `text-overflow: ellipsis` with `max-width: 150px` to truncate long domain names. Reorder arrows only visible on hover (desktop) or on long-press (mobile) to save space.
- **Accessibility (WAI-ARIA Tabs Pattern):** Tab bar uses `role="tablist"`, each tab uses `role="tab"` with `aria-selected`, `aria-controls` pointing to tab panel. Tab panels use `role="tabpanel"`. Arrow keys navigate between tabs.
- **CSRF 403 handling:** When a tab API call returns 403, show a clear error: "Session expired — please refresh the page." This handles stale CSRF tokens on long-lived pages.

**Definition of Done:**

- [ ] Tab bar shows Search tab + all user-created tabs from `ap_explore_tabs`
- [ ] Instance tabs display domain + colored scope badge (local=blue, federated=purple)
- [ ] Hashtag tabs display `#{hashtag}`
- [ ] Clicking a tab switches the visible content panel
- [ ] Close button (×) on non-Search tabs calls remove API and removes tab from bar
- [ ] Up/down arrows on non-Search tabs call reorder API and move tab in bar (debounced 500ms)
- [ ] "Pin as tab" button in search results adds instance+scope to tabs via add API
- [ ] "Add hashtag tab" button (`+#`) opens inline form to add a hashtag tab
- [ ] Tab bar overflow: fade gradients at edges, ellipsis on long labels
- [ ] Tab bar follows WAI-ARIA Tabs Pattern (role=tablist, role=tab, role=tabpanel, aria-selected, aria-controls)
- [ ] Tab bar is keyboard-navigable (arrow keys between tabs)
- [ ] Alpine component guarded with DOM check for non-explore pages
- [ ] Old `.ap-deck-*` CSS removed, new tab styles added
- [ ] `reader-decks.js` script tag replaced with `reader-tabs.js` in layout

**Verify:**

- Open explore page — tab bar visible with Search tab
- Browse an instance in Search tab — "Pin as tab" button appears
- Click "Pin as tab" — new Instance tab appears in tab bar with scope badge
- Click `+#` button — hashtag input form appears, enter "indieweb", confirm — hashtag tab appears as `#indieweb`
- Click the Instance tab — content area switches (empty initially, loaded in Task 5)
- Close button removes the tab
- Up/down arrows reorder tabs (verify via page reload)
- Open a non-explore reader page (e.g., timeline) — no console errors from reader-tabs.js

---

### Task 5: Instance Tab Panel — Full-Width Timeline with Infinite Scroll

**Objective:** When an Instance tab is active, load and display the full-width timeline from that instance with infinite scroll. Reuses `mapMastodonStatusToItem()` and the `exploreApiController` pattern.

**Dependencies:** Task 4

**Files:**

- Modify: `views/activitypub-explore.njk` — Add instance tab panel template section (conditionally visible based on active tab)
- Modify: `assets/reader-tabs.js` — Add timeline loading logic to `apExploreTabs` component for instance tab activation (fetch + render + infinite scroll)
- Modify: `lib/controllers/explore.js` — Ensure `exploreApiController` works for tab-driven requests (may need to accept hashtag param for search tab hashtag mode — already handled in Task 3)

**Key Decisions / Notes:**

- When an instance tab becomes active, if it hasn't loaded yet, fetch the first page from `GET /admin/reader/api/explore?instance={domain}&scope={scope}`
- Infinite scroll uses IntersectionObserver on a sentinel element within the tab panel (same pattern as `apDeckColumn` in `reader-decks.js:100-118`)
- **Tab content cache:** Cached in Alpine state — switching back to a tab shows previously loaded content without re-fetching. **Bounded to last 5 tabs** to prevent memory growth on mobile — when a 6th tab loads, the oldest cached tab's content is cleared (will re-fetch on next activation). Only the first page is cached; accumulated infinite scroll content is discarded on eviction.
- Each tab panel shows loading spinner, error state, retry button (re-fetches without full page reload), and empty state (same states as the old deck column)
- **AbortController:** Each tab's loading state includes an AbortController. When switching away from a loading tab, the in-flight client-side fetch is aborted. When switching back, if content wasn't loaded (cache miss), a fresh request starts. This prevents abandoned HTTP connections from piling up (especially important for hashtag tabs in Task 6).
- Full-width layout — no cramped columns, content fills the available width

**Definition of Done:**

- [ ] Clicking an Instance tab loads the first page of posts from the remote instance
- [ ] Posts display in full-width layout using `ap-item-card.njk` partial
- [ ] Infinite scroll loads more posts when scrolling near the bottom
- [ ] Loading spinner shown during initial load
- [ ] Error state with retry button shown on fetch failure (retry re-fetches without full page reload)
- [ ] Empty state shown when no posts available
- [ ] Switching away and back to a tab preserves already-loaded content (bounded to last 5 tabs)
- [ ] Switching away from a loading tab aborts the in-flight fetch (AbortController)

**Verify:**

- Pin `mastodon.social` (local) as a tab
- Click the tab — posts load in full-width layout
- Scroll down — more posts load via infinite scroll
- Switch to Search tab and back — previously loaded posts still visible

---

### Task 6: Hashtag Tab Panel — Cross-Instance Aggregation

**Objective:** When a Hashtag tab is active, query the hashtag timeline from pinned instance tabs in parallel (capped at 10), merge results by date, and deduplicate by post URL. Uses per-instance cursor pagination for correct multi-source paging.

**Dependencies:** Task 2, Task 5

**Files:**

- Create: `lib/controllers/hashtag-explore.js` — New API endpoint `hashtagExploreApiController` that takes a hashtag and per-instance cursor map, queries pinned instances in parallel, merges, deduplicates, and paginates
- Modify: `index.js` — Register the new hashtag explore API route
- Modify: `assets/reader-tabs.js` — Add hashtag tab loading logic (different API endpoint than instance tabs); manages per-instance cursor state client-side
- Modify: `views/activitypub-explore.njk` — Add hashtag tab panel template section with source instances info line

**Key Decisions / Notes:**

- `GET /admin/reader/api/explore/hashtag?hashtag={tag}&cursors={json}` — New endpoint
- **`MAX_HASHTAG_INSTANCES = 10`**: Hard cap on the number of instances queried per hashtag request. Queries the first 10 instance tabs by `order`. If more exist, the response includes `{ instancesQueried: 10, instancesTotal: N }` so the UI can show "Searching 10 of N instances".
- **Hashtag validation:** Validate hashtag via `validateHashtag()` from `tabs.js` before constructing remote API URLs. Reject invalid hashtags with 400.
- Reads instance tabs from `ap_explore_tabs` where `type === "instance"`, capped at 10 by `order`, then queries each instance's `/api/v1/timelines/tag/{hashtag}?local={scope}&limit=20` in parallel using `Promise.allSettled()`
- Results merged into a single array, sorted by `published` descending
- Deduplication by `uid` (post URL) — first occurrence wins (most recent fetch)
- **Per-instance cursor pagination:** The `cursors` query param is a JSON-encoded map of `{ domain: max_id }` pairs. On each request, each instance is queried with its own `max_id` from the cursor map. The response returns an updated cursor map reflecting the last item from each instance's results. The client stores this cursor map in Alpine state and sends it with the next "load more" request. This ensures correct pagination without missed or duplicate posts across instances with different timeline velocities.
- **Processing pipeline order:** (1) Fetch from all instances in parallel, (2) Merge by published date, (3) Dedup by URL, (4) Slice to page_size (20), (5) THEN render HTML via `request.app.render()` only for the returned items. This prevents wasting CPU rendering items that will be discarded.
- **Per-instance status in response metadata:** Response includes `sources` map: `{ "mastodon.social": "ok", "pixelfed.social": "error:404" }`. The hashtag tab panel shows a line like "Searching #indieweb across 3 instances: mastodon.social, fosstodon.org, ..." and "3 of 5 instances responded" when some fail. This makes the implicit coupling between instance tabs and hashtag tabs explicit.
- Timeout per instance: 10s (same as existing `FETCH_TIMEOUT_MS`). Failed instances excluded from results but reported in `sources`.
- If no instance tabs exist, returns empty results with a message "Pin some instances first"

**Definition of Done:**

- [ ] `GET /admin/reader/api/explore/hashtag?hashtag=indieweb` returns posts from pinned instances (up to 10)
- [ ] Hashtag validated via `validateHashtag()`, invalid hashtags return 400
- [ ] Results sorted by published date descending
- [ ] Duplicate posts (same URL from multiple instances) deduplicated
- [ ] Per-instance status returned in response metadata (`sources` map)
- [ ] Hashtag tab panel shows "Searching #tag across N instances: domain1, domain2, ..."
- [ ] Infinite scroll works with per-instance cursor map pagination (no duplicates or gaps between pages)
- [ ] Maximum 10 instances queried per request (cap enforced)
- [ ] HTML rendering happens AFTER merge/dedup/paginate (not before)
- [ ] Empty state shown when no instance tabs exist (message: "Pin some instances first")
- [ ] Hashtag tab panel displays full-width timeline

**Verify:**

- Pin `mastodon.social` (local) and `fosstodon.org` (local) as instance tabs
- Add a `#indieweb` hashtag tab
- Click the hashtag tab — results from both instances appear, sorted by date
- Source line shows "Searching #indieweb across 2 instances: mastodon.social, fosstodon.org"
- No duplicate posts visible
- Scroll down — infinite scroll loads more posts without duplicates (per-instance cursors work correctly)
- Invalid hashtag (e.g., `../../path`) is rejected with 400

---

### Task 7: Cleanup — Remove Old Deck Code, Update CSS, Update Locales

**Objective:** Remove all remaining references to the old deck system. Clean up CSS (remove `.ap-deck-*` classes), update locale strings, delete `assets/reader-decks.js` (note: `lib/controllers/decks.js` was already deleted in Task 2).

**Dependencies:** Task 4, Task 5, Task 6

**Files:**

- Delete: `assets/reader-decks.js` — Old Alpine deck components (fully replaced by `reader-tabs.js`)
- Modify: `assets/reader.css` — Remove all `.ap-deck-*` and `.ap-explore-deck-toggle*` styles (lines 2063-2248)
- Modify: `assets/reader-infinite-scroll.js` — Remove `apExploreScroll` component (replaced by tab-scoped scroll in `reader-tabs.js`); keep `apInfiniteScroll` unchanged
- Modify: `locales/en.json` — Remove `explore.deck.*` and `explore.tabs.decks` strings; ensure new tab strings are present
- Modify: `index.js` — Verify no remaining imports or references to `decks.js`

**Key Decisions / Notes:**

- `lib/controllers/decks.js` was already deleted in Task 2 — verify it's gone here
- `reader-infinite-scroll.js` still contains `apInfiniteScroll` for the main reader timeline — only remove `apExploreScroll`
- CSS cleanup: remove lines 2063-2248 from `reader.css` (deck toggle, deck grid, deck column, deck empty, deck responsive). Keep `.ap-tabs` styles (extended in Task 4).
- Locale cleanup: remove `explore.deck.*` object entirely, remove `explore.tabs.decks` string
- Verify `reader.css` does not exceed 300 lines per section after changes
- The `ap_decks` collection is left in MongoDB (not explicitly dropped). Users can manually drop it via `mongosh` if desired: `db.ap_decks.drop()`

**Definition of Done:**

- [ ] `lib/controllers/decks.js` confirmed deleted (was done in Task 2)
- [ ] `assets/reader-decks.js` deleted
- [ ] No `.ap-deck-*` CSS classes remain in `reader.css`
- [ ] `apExploreScroll` retained in `reader-infinite-scroll.js` (still used by Search tab's server-rendered infinite scroll)
- [ ] `apInfiniteScroll` still works in `reader-infinite-scroll.js`
- [ ] No `deck` or `ap_decks` references remain anywhere in codebase (except git history)
- [ ] All locale strings clean — no orphaned deck strings

**Verify:**

- `grep -r "ap_decks\|apDeckColumn\|apDeckToggle\|reader-decks" --include="*.js" --include="*.njk" --include="*.json" lib/ views/ assets/ locales/ index.js` returns nothing (apExploreScroll intentionally retained for Search tab)
- `grep -r "ap-deck-" assets/reader.css` returns nothing

## Testing Strategy

- **Unit tests:** No automated test suite exists for this plugin (manual testing only — see CLAUDE.md). However, each task will be verified by:
  1. Checking that the explore page renders correctly via Playwright
  2. Testing API endpoints with curl
  3. Verifying infinite scroll works
- **Integration tests:** Test the full tab lifecycle: add instance tab → browse timeline → add hashtag tab → verify aggregation → reorder → remove
- **Manual verification:**
  1. `playwright-cli open https://rmendes.net/activitypub/admin/reader/explore` — verify UI renders
  2. `curl` the tab API endpoints to verify CRUD operations
  3. Test with multiple instances to verify hashtag aggregation
  4. Test responsive layout on mobile widths

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Hashtag aggregation slow with many instances | Med | Med | Hard cap at MAX_HASHTAG_INSTANCES = 10; `Promise.allSettled()` with per-instance 10s timeout; exclude failed instances; show partial results with source status |
| Hashtag input injection / path traversal | Med | High | `validateHashtag()` enforces `/^[\w]+$/` regex, max 100 chars, strips leading `#`. Called in both tab CRUD and hashtag explore endpoint |
| Mastodon API rate limiting on hashtag queries | Low | Med | Each tab loads independently on user click, not all at once on page load; 10s timeout per instance prevents hanging |
| Tab reordering race condition (concurrent clicks) | Low | Low | Client-side debouncing (500ms) batches rapid arrow clicks into single API call; reorder endpoint accepts full ordered array |
| MongoDB unique index bypass with null fields | Med | Med | All insertions explicitly set ALL four indexed fields (unused fields set to `null`); documented in Task 1 and Task 2 |
| Abandoned HTTP connections on tab switch | Low | Med | AbortController aborts in-flight client fetch when switching away from a loading tab |
| Old `ap_decks` data remains in MongoDB | Low | Low | Old collection is simply not registered; data stays in MongoDB but is unused. User can manually drop via `mongosh` if desired |
| CSS file exceeds 300 line threshold after changes | Low | Med | Deck CSS removal (~185 lines) roughly offsets new tab CSS addition (~100 lines); net reduction in CSS |

## Open Questions

- None — all design decisions were made during brainstorming and refined by plan review findings.

### Deferred Ideas

- Drag-and-drop tab reordering (enhancement over up/down arrows)
- Per-instance hashtag filter within instance tabs
- Auto-refresh / live polling for active tabs
- Tab color customization
- Short-TTL caching (30-60s) for hashtag aggregation results to reduce re-querying on rapid scroll
