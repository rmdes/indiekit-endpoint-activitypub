/**
 * Deck components — Alpine.js components for the TweetDeck-style deck view.
 *
 * Registers:
 *   apDeckToggle  — star/favorite button to add/remove a deck on the Search tab
 *   apDeckColumn  — single deck column with its own infinite-scroll timeline
 */

document.addEventListener("alpine:init", () => {
  // ── apDeckToggle ──────────────────────────────────────────────────────────
  //
  // Star/favorite button that adds or removes a deck entry for the current
  // instance+scope combination.
  //
  // Parameters (passed via x-data):
  //   domain       — instance hostname (e.g. "mastodon.social")
  //   scope        — "local" | "federated"
  //   mountPath    — plugin mount path for API URL construction
  //   csrfToken    — CSRF token from server session
  //   deckCount    — current number of saved decks (for limit enforcement)
  //   initialState — true if this instance+scope is already a deck
  // eslint-disable-next-line no-undef
  Alpine.data("apDeckToggle", (domain, scope, mountPath, csrfToken, deckCount, initialState) => ({
    inDeck: initialState,
    currentCount: deckCount,
    loading: false,

    get deckLimitReached() {
      return this.currentCount >= 8 && !this.inDeck;
    },

    async toggle() {
      if (this.loading) return;
      if (!this.inDeck && this.deckLimitReached) return;

      this.loading = true;
      try {
        const url = this.inDeck
          ? `${mountPath}/admin/reader/api/decks/remove`
          : `${mountPath}/admin/reader/api/decks`;

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ domain, scope }),
        });

        if (res.ok) {
          this.inDeck = !this.inDeck;
          // Track actual count so deckLimitReached stays accurate
          this.currentCount += this.inDeck ? 1 : -1;
        }
      } catch {
        // Network error — state unchanged, server is source of truth
      } finally {
        this.loading = false;
      }
    },
  }));

  // ── apDeckColumn ─────────────────────────────────────────────────────────
  //
  // Individual deck column component. Fetches timeline from the explore API
  // and renders it in a scrollable column with infinite scroll.
  //
  // Uses its own IntersectionObserver referencing `this.$refs.sentinel`
  // (NOT apExploreScroll which hardcodes document.getElementById).
  //
  // Parameters (passed via x-data):
  //   domain    — instance hostname
  //   scope     — "local" | "federated"
  //   mountPath — plugin mount path
  //   index     — column position (0-based), used for staggered loading delay
  //   csrfToken — CSRF token for remove calls
  // eslint-disable-next-line no-undef
  Alpine.data("apDeckColumn", (domain, scope, mountPath, index, csrfToken) => ({
    itemCount: 0,
    html: "",
    maxId: null,
    loading: false,
    done: false,
    error: null,
    observer: null,
    abortController: null,

    init() {
      // Stagger initial fetch: column 0 loads immediately, column N waits N*200ms
      const delay = index * 200;
      if (delay === 0) {
        this.loadMore();
      } else {
        setTimeout(() => {
          this.loadMore();
        }, delay);
      }

      // Set up IntersectionObserver scoped to this column's scrollable body
      // (root must be the scroll container, not viewport, to avoid premature triggers)
      this.$nextTick(() => {
        const root = this.$refs.body || null;
        this.observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting && !this.loading && !this.done && this.itemCount > 0) {
                this.loadMore();
              }
            }
          },
          { root, rootMargin: "200px" },
        );

        if (this.$refs.sentinel) {
          this.observer.observe(this.$refs.sentinel);
        }
      });
    },

    destroy() {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }

      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
    },

    async loadMore() {
      if (this.loading || this.done) return;

      this.loading = true;
      this.error = null;

      try {
        this.abortController = new AbortController();

        const url = new URL(`${mountPath}/admin/reader/api/explore`, window.location.origin);
        url.searchParams.set("instance", domain);
        url.searchParams.set("scope", scope);
        if (this.maxId) url.searchParams.set("max_id", this.maxId);

        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: this.abortController.signal,
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();

        if (data.html && data.html.trim() !== "") {
          this.html += data.html;
          this.itemCount++;
        }

        if (data.maxId) {
          this.maxId = data.maxId;
        } else {
          this.done = true;
        }

        // If no content came back on first load, mark as done
        if (!data.html || data.html.trim() === "") {
          this.done = true;
        }
      } catch (fetchError) {
        this.error = fetchError.message || "Could not load timeline";
      } finally {
        this.loading = false;
      }
    },

    async retryLoad() {
      this.error = null;
      this.done = false;
      await this.loadMore();
    },

    async removeDeck() {
      try {
        const res = await fetch(`${mountPath}/admin/reader/api/decks/remove`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ domain, scope }),
        });

        if (res.ok) {
          // Remove column from DOM
          if (this.observer) {
            this.observer.disconnect();
          }

          this.$el.remove();
        } else {
          this.error = `Failed to remove (${res.status})`;
        }
      } catch {
        this.error = "Network error — could not remove column";
      }
    },
  }));
});
