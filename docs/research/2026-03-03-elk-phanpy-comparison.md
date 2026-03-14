# Elk & Phanpy Deep Dive — Lessons for Our ActivityPub Reader

**Date:** 2026-03-03
**Purpose:** Identify concrete improvements by comparing our reader with two best-in-class fediverse clients.

---

## Architecture Comparison

| Aspect | Elk (Vue/Nuxt) | Phanpy (React/Vite) | Our Reader (Nunjucks/Alpine) |
|--------|----------------|---------------------|------------------------------|
| Rendering | Client-side SPA | Client-side SPA | Server-side HTML + Alpine sprinkles |
| Content processing | AST parse → VNode tree | DOM manipulation pipeline | Server-side sanitize-html |
| State management | Vue refs + composables | Valtio proxy state | Alpine.js `x-data` components |
| Pagination | Virtual scroller + stream | IntersectionObserver + debounce | IntersectionObserver + cursor |
| CSS | UnoCSS (Tailwind-like) | CSS Modules + custom properties | Indiekit theme custom properties |

**Key insight:** Both Elk and Phanpy are full SPAs with rich client-side rendering. Our server-rendered approach is fundamentally different — we can't replicate everything, but we can cherry-pick the most impactful patterns.

---

## 1. Content Rendering

### What Elk & Phanpy Do Better

**Elk's content pipeline:**
1. Parse HTML into AST (ultrahtml)
2. Sanitize with element whitelist
3. Transform mentions → interactive hover cards
4. Transform hashtags → hover cards with usage stats
5. Transform emoji shortcodes → inline images with tooltips
6. Transform code blocks (backtick syntax)
7. Render as Vue VNodes

**Phanpy's content pipeline:**
1. Parse HTML into DOM
2. Shorten long URLs (>30 chars): `https://...example.com/long`
3. Detect hashtag stuffing (3+ tags in paragraph) → collapse
4. Replace custom emoji shortcodes with `<img>` elements
5. Convert backtick code blocks to `<pre><code>`
6. Add `is-quote` class to quote links in content
7. Wrap bare text in `<span>` for Safari text-decoration fix

### What We're Missing

| Feature | Elk | Phanpy | Us | Priority |
|---------|-----|--------|-----|----------|
| Custom emoji rendering | ✅ `:emoji:` → `<img>` with tooltip | ✅ `:emoji:` → `<img>` | ❌ Raw shortcodes shown | **High** |
| Long URL shortening | ❌ | ✅ Truncate >30 chars | ❌ Full URLs shown | Medium |
| Hashtag stuffing collapse | ❌ | ✅ 3+ tags collapsed | ❌ All tags shown inline | Low |
| Mention hover cards | ✅ Full profile card on hover | ❌ | ❌ Links only | Low (needs client JS) |
| Code block rendering | ✅ Syntax highlighting | ✅ Backtick → `<pre>` | ❌ Pass-through only | Low |
| Inline code | ✅ | ✅ Backtick → `<code>` | ❌ | Low |

### Recommended Action: Custom Emoji

Both clients treat this as essential. Implementation for server-rendered HTML:

In `sanitizeContent()` or a new `processEmoji()` step, replace `:shortcode:` with `<img>` tags using the emoji data from the Mastodon API status object (`status.emojis` array). Each emoji has `{ shortcode, url, static_url }`.

```js
// In timeline-store.js or explore-utils.js
function replaceCustomEmoji(html, emojis) {
  if (!emojis?.length) return html;
  for (const emoji of emojis) {
    const re = new RegExp(`:${emoji.shortcode}:`, 'g');
    html = html.replace(re,
      `<img src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" class="ap-custom-emoji" loading="lazy">`
    );
  }
  return html;
}
```

CSS: `.ap-custom-emoji { height: 1.2em; vertical-align: middle; display: inline; }`

---

## 2. Quote Posts

### How Elk Handles Quotes

- Dedicated `StatusQuote.vue` component
- Handles **7 quote states**: pending, revoked, deleted, blocked_account, blocked_domain, muted_account, rejected, accepted
- Only renders full quote embed for `accepted` state
- Renders as a nested `StatusCard` inside a `<blockquote cite="">` element
- Supports shallow quotes (fetch on render) and pre-embedded quotes
- Nesting limit: shows full card for levels 0-2, then author-only for 3+

### How Phanpy Handles Quotes

- `QuoteStatus` / `ShallowQuote` components
- Full quote chain unwrapping (follows `quotedStatusId` up to 30 levels!)
- Handles unfulfilled states (deleted, blocked, muted) with icon + message + optional "Show anyway" button
- Marks quote links in parent content with `is-quote` CSS class (to visually distinguish them)
- Nesting limit: level 3+ shows `@author …` only
- State tracked in Valtio: `states.statusQuotes[statusKey]`

### What We Should Adopt

| Feature | Status | Priority |
|---------|--------|----------|
| Basic quote embed (author, content, photo) | ✅ Done (v2.4.3) | — |
| Strip RE: link when quote renders | ✅ Done (v2.4.2) | — |
| Quote state handling (deleted, pending) | ❌ We show stale/broken embeds | Medium |
| Mark quote links in content CSS | ❌ Quote link looks like any other link | **High** |
| Quote nesting depth limit | ❌ No nesting at all yet | Low |

### Recommended Action: Quote Link Styling

When we strip the `RE: <link>` paragraph, the remaining content is clean. But if we DON'T strip it (e.g., quote not yet fetched), the link should look distinct. Phanpy adds `is-quote` class. We could do this in `sanitizeContent` or in the template.

---

## 3. Media Rendering

### Elk's Media System

- **Grid layouts**: 1 item = full width, 2 = 50/50, 3-4 = 2-column grid
- **Focus point cropping**: Uses `meta.focus.x/y` for intelligent CSS `object-position`
- **Blurhash placeholders**: Generates colored placeholder from blurhash until image loads
- **Progressive loading**: Blurhash → low-res → full-res
- **Lightbox**: Full-screen modal with arrow navigation, counter, alt text display
- **Alt text badge**: "ALT" badge on images with descriptions, click to expand
- **Aspect ratio clamping**: Between 0.8 and 6.0 to prevent extreme shapes
- **Data saving mode**: Blur images until explicit click to load
- **Video autoplay**: IntersectionObserver at 75% visibility, respects reduced-motion preference

### Phanpy's Media System

- **Grid**: `media-eq1` through `media-gt4` CSS classes
- **QuickPinchZoom**: Mobile pinch-to-zoom on images
- **Blurhash**: Average color extracted as background during load
- **Focal point**: CSS custom property `--original-aspect-ratio`
- **Media carousel**: Swipe navigation with snap scroll, RTL support
- **ALT badges**: Indexed "ALT¹", "ALT²" for multiple media
- **Audio/video**: Full HTML5 controls, no autoplay, preload metadata

### What We Have vs. What We're Missing

| Feature | Elk | Phanpy | Us | Priority |
|---------|-----|--------|-----|----------|
| Photo grid (1-4+) | ✅ 2-column adaptive | ✅ CSS class-based | ✅ Grid with +N badge | — |
| Lightbox | ✅ Modal + carousel | ✅ Pinch zoom | ✅ Alpine.js overlay | — |
| Blurhash placeholder | ✅ Canvas decode | ✅ OffscreenCanvas | ❌ No placeholder | Medium |
| Focus point crop | ✅ object-position | ✅ CSS custom prop | ❌ Center crop only | Medium |
| ALT text indicator | ✅ Badge + dropdown | ✅ Indexed badges | ❌ Not shown | **High** |
| Video autoplay/pause | ✅ IntersectionObserver | ✅ Auto-pause on scroll | ❌ Manual only | Low |
| Aspect ratio clamping | ✅ 0.8–6.0 range | ✅ Custom property | ❌ Max-height only | Low |

### Recommended Action: ALT Text Badges

Both clients prominently show ALT text availability. This is an accessibility feature and visual polish win.

```njk
{# In ap-item-media.njk, on each image #}
{% if photo.alt or photo.description %}
  <span class="ap-media__alt-badge" title="{{ photo.alt or photo.description }}">ALT</span>
{% endif %}
```

Note: Our current data model stores photos as URL strings, not objects with alt text. We'd need to change `extractObjectData()` to store `{ url, alt, blurhash, width, height }` objects.

---

## 4. Infinite Scroll / Pagination

### Elk's Approach

- **Virtual scroller** (optional): `vue-virtual-scroller` renders only visible items
- **Stream integration**: WebSocket pushes new posts in real-time
- **New posts banner**: Collected in `prevItems`, shown as "X new items" button
- **Buffering**: Next page items held until buffer reaches 10, then batch-inserted
- **End anchor**: Loads next page when within 2x viewport height of bottom

### Phanpy's Approach

- **IntersectionObserver** with rootMargin = 1.5x screen height
- **Debounced loading** (1s) prevents rapid re-requests
- **Skeleton loaders** during fetch
- **"Show more..." button** as fallback inside observer target
- **Auto-refresh**: Polls periodically if user is near top and window is visible

### Our Current Approach

- **IntersectionObserver** with rootMargin = 200px
- **Cursor-based pagination** with `before` parameter
- **New posts banner** polling every 30s
- **No virtual scrolling** — all cards in DOM
- **No skeleton loaders** — button text changes to "Loading..."

### What We're Missing

| Feature | Elk | Phanpy | Us | Priority |
|---------|-----|--------|-----|----------|
| IntersectionObserver auto-load | ✅ | ✅ 1.5x screen | ✅ 200px margin | — |
| Manual "Load more" button | ✅ | ✅ | ✅ (just added for tabs) | — |
| Skeleton loaders | ✅ | ✅ | ❌ Text "Loading..." only | Medium |
| New posts banner | ✅ WebSocket stream | ✅ Polling | ✅ Polling 30s | — |
| Virtual scrolling | ✅ Optional | ❌ | ❌ | Low (server-rendered) |
| Debounced loading | ❌ | ✅ 1s debounce | ❌ | Low |

### Recommended: Larger IntersectionObserver Margin

Our 200px rootMargin means auto-load triggers late. Both clients use 1.5-2x viewport height. Easy fix:

```js
{ rootMargin: `0px 0px ${window.innerHeight}px 0px` }
```

---

## 5. Content Warnings / Sensitive Content

### Elk's System

- Separate toggles for text spoiler vs. sensitive media
- User preferences: `expandCWByDefault`, `expandMediaByDefault`
- Content filter integration (server-side filters shown as CW)
- Eye icon toggle button
- Dotted border separator between CW text and hidden content

### Phanpy's System

- `states.spoilers[id]` and `states.spoilersMedia[id]` — separate state per post
- User preferences: `readingExpandSpoilers`, `readingExpandMedia`
- Filtered content: Shows filter reason with separate reveal button
- Three sensitivity levels: show_all, hide_all, user-controlled

### Our System

- Single toggle for both text and media (combined)
- CW button with spoiler text shown
- No user preference for auto-expand
- Works well but lacks granularity

### Gap Analysis

| Feature | Elk | Phanpy | Us | Priority |
|---------|-----|--------|-----|----------|
| CW text toggle | ✅ | ✅ | ✅ | — |
| Separate media toggle | ✅ | ✅ | ❌ Combined | Low |
| Auto-expand preference | ✅ | ✅ | ❌ | Low |
| Blurred media preview | ✅ Blurhash | ❌ | ❌ | Medium |

---

## 6. Author Display

### Elk's Approach

- Display name with custom emoji
- Handle with `@username@domain` format
- Bot indicator icon
- Lock (private account) indicator
- **Hover card**: Full profile preview on mouseover (500ms delay) with bio, stats, follow button
- Relative time ("2h ago") with absolute tooltip

### Phanpy's Approach

- Display name with custom emoji and bold
- Username shown only if different from display name (smart dedup)
- Bot accounts get squircle avatar shape
- Role tags (moderator/admin badges)
- **Relative time** with smart formatting
- Punycode handling for international domains
- RTL-safe username display with `bidi-isolate`

### Our Approach

- Display name (sanitized plain text)
- Handle with `@username@domain`
- Absolute timestamp only ("Feb 25, 2026, 4:46 PM")
- No bot/lock indicators
- No hover cards
- No custom emoji in display names

### What We're Missing

| Feature | Elk | Phanpy | Us | Priority |
|---------|-----|--------|-----|----------|
| Custom emoji in names | ✅ | ✅ | ❌ Stripped to text | **High** (same fix as content emoji) |
| Relative timestamps | ✅ "2h ago" | ✅ Smart format | ❌ Absolute only | **High** |
| Bot/lock indicators | ✅ Icons | ✅ Squircle avatar | ❌ | Low |
| Profile hover cards | ✅ Full card | ❌ | ❌ | Low (needs significant JS) |

### Recommended Action: Relative Timestamps

Both clients use relative time for in-feed cards. This is a major readability improvement. Since we server-render, we have two options:

**Option A: Server-side relative time** — Compute in controller, but goes stale.
**Option B: Client-side via Alpine** — Use a small Alpine component that converts ISO dates to relative strings. This is what both Elk and Phanpy do (client-side).

```js
// Small Alpine directive or component
Alpine.directive('relative-time', (el) => {
  const iso = el.getAttribute('datetime');
  const update = () => { el.textContent = formatRelative(iso); };
  update();
  el._interval = setInterval(update, 60000);
});
```

---

## 7. Hashtag Rendering

### Elk

- Hashtags in content preserved as links
- `TagHoverWrapper` shows usage stats on hover
- Sanitizer allows `hashtag` CSS class through

### Phanpy

- Spanifies: `#<span>hashtag</span>` inside link
- Detects **hashtag stuffing** (3+ tags in one paragraph) → collapses with tooltip
- Separate hashtag tags section at bottom of post (from API `tags` array, deduped against content)

### Us

- Hashtags extracted to `category` array, rendered as linked tags below content
- Content HTML hashtag links pass through sanitization
- **Bug found:** Inside `-webkit-line-clamp` containers (quote embeds), the `#<span>tag</span>` structure breaks because `-webkit-box` makes spans block-level (fixed in v2.4.5)

### Recommended Action

Our hashtag rendering is adequate. The main improvement would be Phanpy's hashtag stuffing collapse — but it's low priority since our tag rendering already extracts tags to a footer section.

---

## 8. Interaction UI

### Elk

- **4 buttons**: Reply (blue), Boost (green), Quote (purple), Favorite (rose/yellow)
- **Counts** shown per button (configurable to hide)
- **Color-coded hover states**: Each button tints its area on hover
- **Keyboard shortcuts**: r=reply, b=boost, f=favorite
- **Bookmark** as 5th action

### Phanpy

- **4 buttons**: Reply, Boost, Like, Bookmark
- **StatusButton component** with dual title (checked/unchecked)
- **Shortened counts**: "123K" for large numbers
- **Keyboard shortcuts**: r, b, f, m

### Us

- **5 buttons**: Reply (link), Boost (toggle), Like (toggle), View Original, Save (optional)
- Optimistic UI with revert on error
- CSRF-protected POSTs
- No keyboard shortcuts
- No counts shown

### Gap Analysis

| Feature | Elk | Phanpy | Us | Priority |
|---------|-----|--------|-----|----------|
| Like/Boost/Reply | ✅ | ✅ | ✅ | — |
| Interaction counts | ✅ Per-button | ✅ Shortened | ❌ | Medium |
| Keyboard shortcuts | ✅ | ✅ | ❌ | Low |
| Color-coded buttons | ✅ | ✅ | Partial (active states) | Low |
| Bookmark | ✅ | ✅ | ✅ (Save) | — |
| Quote button | ✅ | ❌ | ❌ | Low |

---

## Priority Improvements — Ranked by Impact

### Tier 1: High Impact, Moderate Effort

1. **Custom emoji rendering** — Both clients treat this as essential. Affects display names AND post content. Single utility function applicable everywhere.

2. **Relative timestamps** — Both clients use this. Major readability improvement for timeline scanning. Small Alpine component.

3. **ALT text badges on media** — Both clients show this prominently. Accessibility win. Requires enriching photo data model from URL strings to objects.

4. **Quote link styling in content** — When `RE:` link isn't stripped (pending quote), distinguish it visually. CSS-only change.

### Tier 2: Medium Impact, Moderate Effort

5. **Skeleton loaders** for pagination — Replace "Loading..." text with card-shaped placeholder skeletons. CSS-only.

6. **Blurhash placeholders** for media — Show colored placeholder while images load. Requires storing blurhash data from API.

7. **Focus point cropping** — Use focal point data for smarter image crops. Requires storing focus data.

8. **Interaction counts** — Show like/boost/reply counts on buttons. Data already available from API.

### Tier 3: Lower Impact or High Effort

9. **Hashtag stuffing collapse** — Collapse posts that are mostly hashtags.
10. **Long URL shortening** — Truncate displayed URLs in content.
11. **Bot/lock indicators** — Show account type badges.
12. **Keyboard shortcuts** — Navigation and interaction hotkeys.
13. **Video autoplay/pause on scroll** — IntersectionObserver for video elements.
14. **Quote state handling** (deleted, pending, blocked) — Show appropriate message instead of broken embed.
15. **Profile hover cards** — Full profile preview on author hover (significant JS investment).

---

## Data Model Gaps

Our timeline items store minimal data compared to what Elk/Phanpy consume. Key missing fields:

| Field | Source | Used For |
|-------|--------|----------|
| `emojis[]` | `status.emojis` | Custom emoji rendering in content + names |
| `media[].alt` | `attachment.description` | ALT text badges |
| `media[].blurhash` | `attachment.blurhash` | Placeholder images |
| `media[].focus` | `attachment.meta.focus` | Smart cropping |
| `media[].width/height` | `attachment.meta.original` | Aspect ratio |
| `repliesCount` | `status.replies_count` | Interaction counts |
| `reblogsCount` | `status.reblogs_count` | Interaction counts |
| `favouritesCount` | `status.favourites_count` | Interaction counts |
| `account.bot` | `account.bot` | Bot indicator |
| `account.emojis` | `account.emojis` | Custom emoji in display names |
| `poll` | `status.poll` | Poll rendering |
| `editedAt` | `status.edited_at` | Edit indicator |

For **inbox-received posts** (via ActivityPub), some of these map to Fedify object properties. For **explore view posts** (via Mastodon REST API), all fields are directly available in the status object.

---

## Architectural Constraints

Our server-rendered approach means we can't do everything Elk and Phanpy do:

1. **No reactive state** — We can't update a card's like count in real-time without a page refresh or AJAX call
2. **No virtual scrolling** — All cards are in the DOM (but server-rendered HTML is lighter than React/Vue vDOM)
3. **No hover cards** — Would require significant Alpine.js investment and API endpoints
4. **No WebSocket streaming** — We poll instead (already have 30s new posts banner)

But we have advantages too:
- **Faster initial load** — Server-rendered HTML is immediately visible
- **Works without JS** — Basic reading works even if Alpine fails
- **Simpler deployment** — No build step, no client bundle
- **Lower maintenance** — No framework version churn
