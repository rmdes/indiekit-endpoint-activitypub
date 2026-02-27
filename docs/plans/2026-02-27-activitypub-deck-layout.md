# ActivityPub Deck Layout Implementation Plan

Created: 2026-02-27
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
> **Worktree:** No — works directly on current branch

## Summary

**Goal:** Add a TweetDeck-style multi-column deck layout to the ActivityPub explore view. Users can favorite/bookmark instances (with local or federated scope) and see them as persistent columns in a deck view, each streaming its own public timeline. The same instance can appear twice with different scopes. Also includes responsive CSS fixes for input fields.

**Architecture:** The explore page gets a two-tab UI: "Search" (existing browse-by-search) and "Decks" (multi-column layout of favorited instances). Favorited instances are stored in a new `ap_decks` MongoDB collection. Each deck column is an independent Alpine.js component that fetches timelines via the existing `/api/explore` AJAX endpoint. Deck CRUD is handled via JSON API endpoints. A "favorite" button on the search view lets users save the current instance+scope as a deck.

**Tech Stack:** Alpine.js (client-side reactivity), Express routes (API), MongoDB (persistence), CSS Grid (responsive multi-column layout), existing Mastodon-compatible public timeline API.

## Scope

### In Scope

- New `ap_decks` MongoDB collection for storing favorited instances
- CRUD API endpoints for deck management (add, remove, list)
- Two-tab explore page: "Search" tab (existing) and "Decks" tab (new)
- Multi-column deck layout with CSS Grid, responsive wrapping
- Each deck column loads its timeline via AJAX with infinite scroll
- "Add to deck" button on the search view when browsing an instance
- Visual badge for local vs federated scope on each column header
- Remove deck button on each column header
- Responsive CSS fix for `.ap-lookup__input` and `.ap-explore-form__input`
- i18n strings for all new UI elements

### Out of Scope

- Drag-and-drop column reordering (complex, future enhancement)
- Auto-refresh / live streaming of deck columns (future enhancement)
- Cross-column interactions (liking/boosting from deck columns)
- Custom column names (domain+scope is the label)
- Deck columns for non-Mastodon-compatible instances

## Prerequisites

- Existing explore controller with `exploreApiController` for AJAX timeline loading (`lib/controllers/explore.js`)
- Existing `apExploreScroll` Alpine.js component for infinite scroll (`assets/reader-infinite-scroll.js`)
- Alpine.js loaded via CDN in `views/layouts/ap-reader.njk`
- FediDB autocomplete already working on explore page

## Context for Implementer

> This section is critical for cross-session continuity.

- **Patterns to follow:**
  - Route registration: Follow the pattern in `index.js:234` — all deck routes go in the `routes` getter (authenticated admin routes, behind IndieAuth)
  - Controller factory pattern: All controllers are factory functions returning `(request, response, next)` — see `explore.js:119`
  - MongoDB collection access: `request.app.locals.application.collections.get("ap_decks")` or pass via factory closure
  - Alpine.js component registration: via `alpine:init` event, see `assets/reader-autocomplete.js:6`
  - Infinite scroll: Deck columns must implement their OWN scroll handler (NOT reuse `apExploreScroll` — see gotcha below)
  - CSS custom properties: Use Indiekit theme vars (`--color-*`, `--space-*`, `--border-*`) — see `assets/reader.css`

- **Conventions:**
  - All controllers are ESM modules with named exports
  - CSS class naming: `ap-<feature>__<element>--<modifier>` (BEM-like)
  - Template naming: `activitypub-<feature>.njk` with `ap-reader.njk` layout
  - i18n: All user-visible strings go in `locales/en.json` under `activitypub.reader.explore.deck.*`
  - Dates stored as ISO 8601 strings: always `new Date().toISOString()`, never `new Date()` (CRITICAL — see CLAUDE.md)

- **Key files the implementer must read first:**
  - `lib/controllers/explore.js` — Existing explore controller with timeline fetching, SSRF validation, Mastodon API mapping
  - `views/activitypub-explore.njk` — Current explore template
  - `assets/reader-infinite-scroll.js` — `apExploreScroll` Alpine component for explore infinite scroll
  - `assets/reader-autocomplete.js` — `apInstanceSearch` Alpine component for autocomplete
  - `index.js:226-238` — Route registration for explore endpoints (in the `routes` getter)
  - `index.js:862-878` — MongoDB collection registration

- **Gotchas:**
  - The explore API (`/api/explore`) already server-side renders card HTML via `request.app.render()` — deck columns can reuse this
  - Template name collisions: Use `ap-` prefix for all new templates (see CLAUDE.md gotcha #7)
  - Express 5 removed `redirect("back")` — always use explicit redirect paths
  - The `validateInstance()` function in `explore.js` is NOT currently exported — Task 2 must export it before importing in `decks.js`
  - Alpine components MUST load via `defer` script tags BEFORE the Alpine CDN script — `reader-decks.js` must be added before the Alpine CDN `<script>` in `ap-reader.njk`
  - **`apExploreScroll` CANNOT be reused for deck columns:** It hardcodes `document.getElementById("ap-explore-timeline")` at line 48 — with multiple deck columns, `getElementById` only finds the first one. Deck columns MUST implement their own scroll handler using `this.$refs` or `this.$el.querySelector()` to reference the column's own container.
  - **CSRF protection is required** on all deck CRUD endpoints. The codebase has `lib/csrf.js` with `getToken()` and `validateToken()`. The `exploreController` must pass `csrfToken: getToken(request.session)` to the template, and client-side `fetch()` calls must include the `X-CSRF-Token` header. Server-side endpoints must call `validateToken(request)` before processing.

- **Domain context:**
  - "Local" timeline = posts from users who have accounts on that instance
  - "Federated" timeline = all posts that instance's relay has seen from across the fediverse
  - Mastodon API: `GET /api/v1/timelines/public?local=true|false&limit=N&max_id=ID`
  - Not all instances support public timeline access (some return 401/422) — the FediDB instance-check endpoint already handles this

## Runtime Environment

- **Start command:** Part of Indiekit — `npm start` or deployed via Cloudron
- **Port:** 8080 (behind nginx on Cloudron)
- **Deploy path:** Published to npm, installed in `indiekit-cloudron/Dockerfile`
- **Health check:** Served via Indiekit's built-in health endpoint
- **Restart procedure:** `cloudron restart --app rmendes.net` or bump version + `npm publish` + `cloudron build`

## Progress Tracking

**MANDATORY: Update this checklist as tasks complete. Change `[ ]` to `[x]`.**

- [x] Task 1: Responsive CSS fix + deck collection setup
- [x] Task 2: Deck CRUD API endpoints
- [x] Task 3: Two-tab explore page layout
- [x] Task 4: "Add to deck" button on search view
- [x] Task 5: Deck column Alpine.js component
- [x] Task 6: Multi-column deck view with responsive grid

**Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: Responsive CSS Fix + Deck Collection Setup

**Objective:** Commit the pending responsive CSS changes and register the new `ap_decks` MongoDB collection with proper indexes.

**Dependencies:** None

**Files:**

- Modify: `assets/reader.css` (already has uncommitted changes — commit the existing diff as-is)
- Modify: `index.js` (add `ap_decks` collection registration + index)

**Key Decisions / Notes:**

- The CSS diff changes `.ap-lookup__input` and `.ap-explore-form__input` from `flex: 1` to `width: 100%; box-sizing: border-box`, and also alphabetically reorders properties. Commit the existing diff without additional changes.
- New collection `ap_decks` stores deck entries: `{ domain, scope, addedAt }`
- `addedAt` MUST be stored as `new Date().toISOString()` per the date convention (never `new Date()`)
- Compound unique index on `{ domain: 1, scope: 1 }` allows same instance with different scopes
- Column order is determined by `addedAt` ascending (no separate position field — drag-and-drop reordering is out of scope)
- Collection registration follows the pattern at `index.js:862-878`
- Collection reference added to `this._collections` object at `index.js:882-903`

**Definition of Done:**

- [ ] `ap_decks` collection is registered in `index.js` init method
- [ ] `ap_decks` has compound unique index `{ domain: 1, scope: 1 }`
- [ ] `ap_decks` is added to `this._collections` for controller access
- [ ] Responsive CSS fix is included (commit existing diff as-is)

**Verify:**

- `grep "ap_decks" index.js` — collection registered and referenced
- Visual check: input fields span full width on explore and reader pages

### Task 2: Deck CRUD API Endpoints

**Objective:** Create API endpoints for managing deck entries: list all decks, add a deck, remove a deck. Export `validateInstance()` from `explore.js` for reuse.

**Dependencies:** Task 1

**Files:**

- Modify: `lib/controllers/explore.js` (export `validateInstance()`)
- Create: `lib/controllers/decks.js`
- Modify: `index.js` (import and register routes in the `routes` getter)

**Key Decisions / Notes:**

- First, export `validateInstance()` from `explore.js` by changing `function validateInstance` to `export function validateInstance`
- Three endpoints, all registered in the `routes` getter (authenticated via IndieAuth):
  - `GET /admin/reader/api/decks` — returns all decks sorted by `addedAt` ascending
  - `POST /admin/reader/api/decks` — body: `{ domain, scope }`. Validates domain via `validateInstance()`. Returns the created deck.
  - `POST /admin/reader/api/decks/remove` — body: `{ domain, scope }`. Removes the deck entry. Returns `{ success: true }`. Uses POST instead of DELETE to avoid issues with request bodies being stripped by proxies/CDNs.
- Follow the controller factory pattern from `explore.js:119` — each endpoint is a factory function returning `(req, res, next)`
- Maximum 8 decks enforced: `POST /api/decks` returns 400 if user already has 8 or more
- **CSRF protection:** Both `POST /api/decks` and `POST /api/decks/remove` must call `validateToken(request)` from `lib/csrf.js` before processing. Return 403 if invalid.

**Definition of Done:**

- [ ] `validateInstance()` is exported from `explore.js` for reuse by deck endpoints
- [ ] `GET /api/decks` returns JSON array of decks sorted by addedAt
- [ ] `POST /api/decks` with `{ domain: "mastodon.social", scope: "local" }` creates a deck entry
- [ ] `POST /api/decks` with invalid domain returns 400 error
- [ ] `POST /api/decks` with duplicate domain+scope returns 409 conflict
- [ ] `POST /api/decks` returns 400 if user already has 8 or more decks
- [ ] `POST /api/decks/remove` with `{ domain, scope }` removes the entry
- [ ] All endpoints are registered in the `routes` getter (behind IndieAuth)
- [ ] All endpoints use `validateInstance()` for SSRF prevention
- [ ] `POST /api/decks` and `POST /api/decks/remove` validate CSRF token via `validateToken(request)` from `lib/csrf.js`

**Verify:**

- `curl` commands against the running instance to test CRUD operations
- `grep "api/decks" index.js` — routes registered in the `routes` getter

### Task 3: Two-Tab Explore Page Layout

**Objective:** Restructure the explore page with tab navigation: "Search" (existing functionality) and "Decks" (new deck view). Server-rendered tabs with URL parameter switching.

**Dependencies:** Task 1

**Files:**

- Modify: `views/activitypub-explore.njk`
- Modify: `lib/controllers/explore.js` (pass `decks` and `activeTab` to template)
- Modify: `assets/reader.css` (tab styles)
- Modify: `locales/en.json` (new i18n strings)

**Key Decisions / Notes:**

- Tab switching via `?tab=search|decks` query parameter, default "search"
- The `exploreController` fetches deck list from `ap_decks` and passes to template as `decks`
- The `exploreController` must also pass `csrfToken: getToken(request.session)` to the template so Alpine.js components can include it in `X-CSRF-Token` headers on fetch calls
- Tab CSS follows the existing notification tabs pattern (see `activitypub-notifications.njk` if available, or design from scratch using `ap-explore-tabs__*` class prefix)
- The "Decks" tab content is a container that the Alpine.js deck components (Task 5-6) will populate
- When `?tab=decks` and no decks exist, show an empty state message explaining how to add decks

**Definition of Done:**

- [ ] Explore page shows two tabs: "Search" and "Decks"
- [ ] Clicking "Search" tab shows `?tab=search` with existing explore UI
- [ ] Clicking "Decks" tab shows `?tab=decks` with deck container
- [ ] Active tab is visually highlighted
- [ ] "Decks" tab with no decks shows empty state message
- [ ] All new strings are in `locales/en.json`

**Verify:**

- Navigate to `/activitypub/admin/reader/explore` — see Search tab active by default
- Navigate to `/activitypub/admin/reader/explore?tab=decks` — see Decks tab active
- Check i18n strings present: `grep "deck" locales/en.json`

### Task 4: "Add to Deck" Button on Search View

**Objective:** Add a "favorite" / "Add to deck" button on the search results view that saves the current instance+scope as a deck column.

**Dependencies:** Task 2, Task 3

**Files:**

- Modify: `views/activitypub-explore.njk` (add star/favorite button)
- Modify: `assets/reader.css` (button styles)
- Create: `assets/reader-decks.js` (Alpine.js component for deck management)
- Modify: `views/layouts/ap-reader.njk` (add script tag for reader-decks.js — MUST be placed BEFORE the Alpine CDN script, alongside the other component scripts)
- Modify: `locales/en.json` (button labels)

**Key Decisions / Notes:**

- The button appears next to the "Browse" button when viewing an instance timeline (results are showing)
- Alpine.js `apDeckToggle` component: checks if current instance+scope is already a deck, shows filled/empty star
- On click: calls `POST /api/decks` or `POST /api/decks/remove` to toggle
- **CSRF token:** All fetch calls must include `X-CSRF-Token` header with the token from the template (passed via a `data-csrf-token` attribute on the component's container, populated by `{{ csrfToken }}` from the server)
- Visual feedback: star fills/empties, brief toast or inline feedback
- **Max deck limit enforcement:** The component must know the current deck count. When 8 decks exist and the instance is not already favorited, the star button should be disabled with a tooltip explaining the limit. The template must pass the deck count (or max-reached boolean) so the Alpine component can check.
- The new `reader-decks.js` file will hold both the deck toggle and the deck column components (Task 5)
- The `<script defer>` tag in `ap-reader.njk` MUST be placed before the Alpine CDN `<script>` so the component is registered via `alpine:init` before Alpine initializes

**Definition of Done:**

- [ ] Star button appears when browsing an instance timeline on the Search tab
- [ ] Clicking the star when not favorited calls `POST /api/decks` and fills the star
- [ ] Clicking the star when already favorited calls `POST /api/decks/remove` and empties the star
- [ ] Star state is correct on page load (pre-checked against existing decks)
- [ ] Button has appropriate aria-label and title text
- [ ] Fetch calls include `X-CSRF-Token` header with token from template
- [ ] Star button is disabled with tooltip when 8 decks already exist (and current instance is not already favorited)
- [ ] `reader-decks.js` script tag is placed before Alpine CDN script in `ap-reader.njk`

**Verify:**

- Browse mastodon.social local timeline → star button visible
- Click star → star fills, deck entry created (verify via `GET /api/decks`)
- Reload page → star is still filled
- Click star again → star empties, deck entry removed

### Task 5: Deck Column Alpine.js Component

**Objective:** Create the `apDeckColumn` Alpine.js component that loads a single instance's timeline into a scrollable column with infinite scroll.

**Dependencies:** Task 2

**Files:**

- Modify: `assets/reader-decks.js` (add `apDeckColumn` component)

**Key Decisions / Notes:**

- Each column is an independent Alpine.js component initialized with `domain` and `scope` props
- On init, fetches timeline from `GET /admin/reader/api/explore?instance={domain}&scope={scope}`
- Response includes `{ html, maxId }` — the HTML is server-rendered card markup
- Column maintains its own `maxId` for pagination, own `loading` and `done` states
- **Own scroll handler (NOT `apExploreScroll`):** The `apDeckColumn` component MUST implement its own IntersectionObserver-based scroll handler. The existing `apExploreScroll` uses `document.getElementById("ap-explore-timeline")` which only finds the first element — it fundamentally cannot work with multiple columns. The deck column component should use `this.$refs.sentinel` or `this.$el.querySelector('.ap-deck-column__sentinel')` to observe within its own container.
- Column header shows: instance domain, scope badge (Local/Federated), and a remove button
- Remove button calls `POST /api/decks/remove` (with CSRF token in `X-CSRF-Token` header) then removes the column from DOM
- Error handling: if instance is unreachable, show error message in column body with a "Retry" button that re-triggers the fetch
- Loading state: show spinner/skeleton while first batch loads
- **Staggered initial fetch:** Columns delay their initial fetch based on their index (column 0 = immediate, column 1 = 500ms, column 2 = 1000ms, etc.) to avoid thundering herd when many columns load simultaneously

**Definition of Done:**

- [ ] `apDeckColumn` component fetches and renders timeline items from remote instance
- [ ] Infinite scroll loads more items as user scrolls down in the column
- [ ] Column header shows domain name and scope badge
- [ ] Remove button removes deck from DB and removes column from DOM
- [ ] Loading spinner shown during initial fetch
- [ ] Error message shown if instance is unreachable, with a "Retry" button
- [ ] Scroll handler uses `this.$refs` or `this.$el.querySelector()` (NOT `document.getElementById`)
- [ ] Remove button sends CSRF token via `X-CSRF-Token` header
- [ ] Columns stagger their initial fetch with 500ms delay per column index

**Verify:**

- Add a deck for mastodon.social (local) → column loads timeline items
- Scroll to bottom of column → more items load
- Click remove → column disappears, `GET /api/decks` no longer includes it

### Task 6: Multi-Column Deck View with Responsive Grid

**Objective:** Build the deck view that renders all favorited instances as a multi-column layout using CSS Grid, with responsive behavior.

**Dependencies:** Task 3, Task 5

**Files:**

- Modify: `views/activitypub-explore.njk` (deck view section with column containers)
- Modify: `assets/reader.css` (CSS Grid layout, responsive breakpoints)
- Modify: `assets/reader-decks.js` (deck view initialization)
- Modify: `locales/en.json` (empty states, column labels)

**Key Decisions / Notes:**

- CSS Grid layout: `grid-template-columns: repeat(auto-fill, minmax(360px, 1fr))`
  - Desktop: columns sit side-by-side (2-3 columns on wide screens)
  - Tablet: 2 columns
  - Mobile (<768px): single column, stacked vertically
- Each column has a fixed max-height with internal scrolling (`overflow-y: auto`)
- Column max-height: `calc(100vh - 200px)` (viewport minus header/tabs)
- Scope badge styling: "Local" gets a blue badge, "Federated" gets a purple badge
- Empty deck view: centered message with explanation and a link to the Search tab
- Column order follows `addedAt` ascending from `ap_decks` (oldest first)
- The deck view template renders column containers server-side (from `decks` data), but each column loads its content client-side via Alpine.js
- Column containers have `x-data="apDeckColumn('domain', 'scope', 'mountPath', index)"` attributes (index used for stagger delay)

**Definition of Done:**

- [ ] Deck view renders all favorited instances as columns
- [ ] Columns sit side-by-side on desktop (≥1024px)
- [ ] Columns stack vertically on mobile (<768px)
- [ ] Each column has its own scrollbar for long timelines
- [ ] Scope badges show "Local" (blue) or "Federated" (purple) per column
- [ ] Empty deck view shows helpful message with link to Search tab
- [ ] Column order matches addedAt ascending in `ap_decks`

**Verify:**

- Add 3 decks → see 3 columns on desktop
- Resize browser to mobile → columns stack
- Each column scrolls independently
- Empty decks view shows the empty state message

## Testing Strategy

- **Unit tests:** No automated test suite exists. Manual testing against real fediverse instances.
- **Integration tests:** Test deck CRUD API endpoints via `curl`:
  - `POST /api/decks` with valid/invalid/duplicate data
  - `GET /api/decks` returns correct list
  - `POST /api/decks/remove` removes entries
- **Manual verification:**
  1. Add 2-3 decks (mix of local/federated)
  2. Switch to Decks tab — see columns
  3. Scroll columns — infinite scroll works
  4. Remove a deck from column header — column disappears
  5. Add same instance with different scope — both columns appear
  6. Resize browser — responsive layout works
  7. Test on deployed Cloudron instance

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Multiple columns fetching simultaneously may slow page load | Medium | Medium | Stagger initial column fetches with 500ms delay per column index (column 0 immediate, column 1 at 500ms, etc.) |
| Remote instances may block or rate-limit multiple simultaneous timeline requests | Low | Medium | Each column fetches independently with its own AbortController; timeout at 10s (existing FETCH_TIMEOUT_MS) |
| Large number of deck columns may cause layout issues | Low | Low | Cap maximum decks at 8; `POST /api/decks` returns 400 if limit reached |
| Instance timeline API format varies across Mastodon forks | Low | Medium | The existing `mapMastodonStatusToItem()` in `explore.js` already handles this; deck columns reuse same API |
| CSS Grid not supported in very old browsers | Very Low | Low | CSS Grid has >97% browser support; fallback is single-column layout (natural Grid behavior) |

## Open Questions

- None — requirements are clear from user description.

### Deferred Ideas

- Drag-and-drop column reordering
- Auto-refresh / live streaming of deck columns (WebSocket or polling)
- Deck column width customization
- Cross-column interactions (like/boost directly from deck columns without opening post)
- Deck sharing/export (export deck configuration)
- Deck presets (pre-configured sets of popular instances)
