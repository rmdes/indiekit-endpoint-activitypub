/**
 * Tab components — Alpine.js component for the tabbed explore page.
 *
 * Registers:
 *   apExploreTabs — tab management, timeline loading, infinite scroll
 *
 * Guard: init() exits early when .ap-explore-tabs-container is absent so
 * this script is safe to load on all reader pages via the shared layout.
 *
 * Configuration is read from data-* attributes on the root element:
 *   data-mount-path — plugin mount path for API URL construction
 *   data-csrf       — CSRF token from server session
 */

document.addEventListener("alpine:init", () => {
  // eslint-disable-next-line no-undef
  Alpine.data("apExploreTabs", () => ({
    // ── Tab list and active state ────────────────────────────────────────────
    tabs: [],
    activeTabId: null, // null = Search tab; string = user tab _id

    // ── Tab management UI state ──────────────────────────────────────────────
    pinning: false,
    showHashtagForm: false,
    hashtagInput: "",
    error: null,

    // ── Per-tab content state (keyed by tab _id) ─────────────────────────────
    // Each entry: { loading, error, html, maxId, done, abortController }
    // Hashtag tabs additionally carry: { cursors, sourceMeta }
    //   cursors: { [domain]: maxId|null } — per-instance pagination cursors
    //   sourceMeta: { instancesQueried, instancesTotal, instanceLabels }
    tabState: {},

    // ── Bounded content cache (last 5 tabs, LRU by access order) ────────────
    _cacheOrder: [],

    // ── Scroll observer for the active tab ───────────────────────────────────
    _tabObserver: null,

    // ── Configuration (read from data attributes) ────────────────────────────
    _mountPath: "",
    _csrfToken: "",
    _reorderTimer: null,

    // ── Lifecycle ────────────────────────────────────────────────────────────

    init() {
      if (!document.querySelector(".ap-explore-tabs-container")) return;
      this._mountPath = this.$el.dataset.mountPath || "";
      this._csrfToken = this.$el.dataset.csrf || "";
      this._loadTabs();
    },

    destroy() {
      if (this._tabObserver) {
        this._tabObserver.disconnect();
        this._tabObserver = null;
      }
      if (this._reorderTimer) {
        clearTimeout(this._reorderTimer);
        this._reorderTimer = null;
      }
      // Abort any in-flight requests
      for (const state of Object.values(this.tabState)) {
        if (state.abortController) state.abortController.abort();
      }
    },

    async _loadTabs() {
      try {
        const res = await fetch(
          `${this._mountPath}/admin/reader/api/tabs`,
          { headers: { Accept: "application/json" } }
        );
        if (!res.ok) return;
        const data = await res.json();
        this.tabs = data.map((t) => ({ ...t, _id: String(t._id) }));
      } catch {
        // Non-critical — tab bar degrades gracefully to Search-only
      }
    },

    // ── Tab content state helpers ─────────────────────────────────────────────

    _getState(tabId) {
      return this.tabState[tabId] || {
        loading: false, error: null, html: "", maxId: null, done: false,
        abortController: null,
      };
    },

    _setState(tabId, update) {
      const current = this._getState(tabId);
      this.tabState = { ...this.tabState, [tabId]: { ...current, ...update } };
    },

    // LRU cache management — evict oldest when cache grows past 5 tabs
    _touchCache(tabId) {
      this._cacheOrder = this._cacheOrder.filter((id) => id !== tabId);
      this._cacheOrder.push(tabId);

      while (this._cacheOrder.length > 5) {
        const evictId = this._cacheOrder.shift();
        const evictedState = this.tabState[evictId];
        if (evictedState) {
          this._setState(evictId, {
            html: "", maxId: null, done: false, loading: false,
          });
        }
      }
    },

    // ── Tab switching ─────────────────────────────────────────────────────────

    switchToSearch() {
      this._abortActiveTabFetch();
      this._teardownScrollObserver();
      this.activeTabId = null;
      this.error = null;
    },

    switchTab(tabId) {
      if (this.activeTabId === tabId) return;
      this._abortActiveTabFetch();
      this._teardownScrollObserver();
      this.activeTabId = tabId;
      this.error = null;

      const tab = this.tabs.find((t) => t._id === tabId);
      if (!tab) return;

      const state = this._getState(tabId);

      if (tab.type === "instance") {
        if (!state.html && !state.loading) {
          // Cache miss — load first page
          this.$nextTick(() => this._loadInstanceTab(tab));
        } else if (state.html) {
          // Cache hit — restore scroll observer
          this._touchCache(tabId);
          this.$nextTick(() => this._setupScrollObserver(tab));
        }
      } else if (tab.type === "hashtag") {
        if (!state.html && !state.loading) {
          this.$nextTick(() => this._loadHashtagTab(tab));
        } else if (state.html) {
          this._touchCache(tabId);
          this.$nextTick(() => this._setupScrollObserver(tab));
        }
      }
    },

    _abortActiveTabFetch() {
      if (!this.activeTabId) return;
      const state = this._getState(this.activeTabId);
      if (state.abortController) {
        state.abortController.abort();
        this._setState(this.activeTabId, {
          abortController: null,
          loading: false,
        });
      }
    },

    // ── Instance tab loading ──────────────────────────────────────────────────

    async _loadInstanceTab(tab) {
      const tabId = tab._id;
      const abortController = new AbortController();
      this._setState(tabId, {
        loading: true, error: null, abortController,
      });

      try {
        const url = new URL(
          `${this._mountPath}/admin/reader/api/explore`,
          window.location.origin
        );
        url.searchParams.set("instance", tab.domain);
        url.searchParams.set("scope", tab.scope);

        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        this._setState(tabId, {
          loading: false,
          abortController: null,
          html: data.html || "",
          maxId: data.maxId || null,
          done: !data.maxId,
          error: null,
        });

        this._touchCache(tabId);

        // Set up scroll observer after DOM updates
        this.$nextTick(() => this._setupScrollObserver(tab));
      } catch (err) {
        if (err.name === "AbortError") return; // Tab was switched away — silent
        this._setState(tabId, {
          loading: false,
          abortController: null,
          error: err.message || "Could not load timeline",
        });
      }
    },

    async _loadMoreInstanceTab(tab) {
      const tabId = tab._id;
      const state = this._getState(tabId);
      if (state.loading || state.done || !state.maxId) return;

      const abortController = new AbortController();
      this._setState(tabId, { loading: true, abortController });

      try {
        const url = new URL(
          `${this._mountPath}/admin/reader/api/explore`,
          window.location.origin
        );
        url.searchParams.set("instance", tab.domain);
        url.searchParams.set("scope", tab.scope);
        url.searchParams.set("max_id", state.maxId);

        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const current = this._getState(tabId);

        this._setState(tabId, {
          loading: false,
          abortController: null,
          html: current.html + (data.html || ""),
          maxId: data.maxId || null,
          done: !data.maxId,
        });
      } catch (err) {
        if (err.name === "AbortError") return;
        this._setState(tabId, {
          loading: false,
          abortController: null,
          error: err.message || "Could not load more posts",
        });
      }
    },

    // ── Hashtag tab loading ───────────────────────────────────────────────────

    async _loadHashtagTab(tab) {
      const tabId = tab._id;
      const abortController = new AbortController();
      this._setState(tabId, { loading: true, error: null, abortController });

      try {
        const url = new URL(
          `${this._mountPath}/admin/reader/api/explore/hashtag`,
          window.location.origin
        );
        url.searchParams.set("hashtag", tab.hashtag);
        url.searchParams.set("cursors", "{}");

        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        this._setState(tabId, {
          loading: false,
          abortController: null,
          html: data.html || "",
          cursors: data.cursors || {},
          sourceMeta: {
            instancesQueried: data.instancesQueried || 0,
            instancesTotal: data.instancesTotal || 0,
            instanceLabels: data.instanceLabels || [],
          },
          done: !data.html || Object.values(data.cursors || {}).every((c) => !c),
          error: null,
        });

        this._touchCache(tabId);
        this.$nextTick(() => this._setupScrollObserver(tab));
      } catch (err) {
        if (err.name === "AbortError") return;
        this._setState(tabId, {
          loading: false,
          abortController: null,
          error: err.message || "Could not load hashtag timeline",
        });
      }
    },

    async _loadMoreHashtagTab(tab) {
      const tabId = tab._id;
      const state = this._getState(tabId);
      if (state.loading || state.done) return;

      const abortController = new AbortController();
      this._setState(tabId, { loading: true, abortController });

      try {
        const url = new URL(
          `${this._mountPath}/admin/reader/api/explore/hashtag`,
          window.location.origin
        );
        url.searchParams.set("hashtag", tab.hashtag);
        url.searchParams.set("cursors", JSON.stringify(state.cursors || {}));

        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const current = this._getState(tabId);

        const allCursorsExhausted = Object.values(data.cursors || {}).every(
          (c) => !c
        );

        this._setState(tabId, {
          loading: false,
          abortController: null,
          html: current.html + (data.html || ""),
          cursors: data.cursors || {},
          done: !data.html || allCursorsExhausted,
        });
      } catch (err) {
        if (err.name === "AbortError") return;
        this._setState(tabId, {
          loading: false,
          abortController: null,
          error: err.message || "Could not load more posts",
        });
      }
    },

    async retryTab(tab) {
      const tabId = tab._id;
      this._setState(tabId, {
        error: null, html: "", maxId: null, done: false,
        cursors: {}, sourceMeta: null,
      });
      if (tab.type === "instance") {
        await this._loadInstanceTab(tab);
      } else if (tab.type === "hashtag") {
        await this._loadHashtagTab(tab);
      }
    },

    // ── Infinite scroll for tab panels ───────────────────────────────────────

    _setupScrollObserver(tab) {
      this._teardownScrollObserver();

      const panel = this.$el.querySelector(`#ap-tab-panel-${tab._id}`);
      if (!panel) return;

      const sentinel = panel.querySelector(".ap-tab-sentinel");
      if (!sentinel) return;

      this._tabObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const state = this._getState(tab._id);
              if (!state.loading && !state.done) {
                if (tab.type === "instance" && state.maxId) {
                  this._loadMoreInstanceTab(tab);
                } else if (tab.type === "hashtag") {
                  this._loadMoreHashtagTab(tab);
                }
              }
            }
          }
        },
        { rootMargin: "200px" }
      );
      this._tabObserver.observe(sentinel);
    },

    _teardownScrollObserver() {
      if (this._tabObserver) {
        this._tabObserver.disconnect();
        this._tabObserver = null;
      }
    },

    // ── Tab label helpers ─────────────────────────────────────────────────────

    tabLabel(tab) {
      return tab.type === "instance" ? tab.domain : `#${tab.hashtag}`;
    },

    hashtagSourcesLine(tab) {
      const state = this._getState(tab._id);
      const meta = state.sourceMeta;
      if (!meta || !meta.instancesQueried) return "";
      const n = meta.instancesQueried;
      const total = meta.instancesTotal;
      const labels = meta.instanceLabels || [];
      const tag = tab.hashtag || "";
      const suffix = n === 1 ? "instance" : "instances";
      let line = `Searching #${tag} across ${n} ${suffix}`;
      if (n < total) {
        line += ` (${n} of ${total} pinned)`;
      }
      if (labels.length > 0) {
        line += `: ${labels.join(", ")}`;
      }
      return line;
    },

    // ── Keyboard navigation (WAI-ARIA Tabs pattern) ───────────────────────────

    handleTabKeydown(event, currentIndex) {
      const total = this.tabs.length + 1;
      let nextIndex = null;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        nextIndex = (currentIndex + 1) % total;
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        nextIndex = (currentIndex - 1 + total) % total;
      } else if (event.key === "Home") {
        event.preventDefault();
        nextIndex = 0;
      } else if (event.key === "End") {
        event.preventDefault();
        nextIndex = total - 1;
      }

      if (nextIndex !== null) {
        const tabEls = this.$el.querySelectorAll('[role="tab"]');
        if (tabEls[nextIndex]) tabEls[nextIndex].focus();
      }
    },

    // ── Pin current search result as instance tab ─────────────────────────────

    async pinInstance(domain, scope) {
      if (this.pinning) return;
      this.pinning = true;
      this.error = null;

      try {
        const res = await fetch(
          `${this._mountPath}/admin/reader/api/tabs`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": this._csrfToken,
            },
            body: JSON.stringify({ type: "instance", domain, scope }),
          }
        );

        if (res.status === 409) {
          const existing = this.tabs.find(
            (t) => t.type === "instance" && t.domain === domain && t.scope === scope
          );
          if (existing) this.switchTab(existing._id);
          return;
        }

        if (res.status === 403) {
          this.error = "Session expired — please refresh the page.";
          return;
        }

        if (!res.ok) return;

        const newTab = await res.json();
        newTab._id = String(newTab._id);
        this.tabs.push(newTab);
        this.switchTab(newTab._id);
      } catch {
        // Network error — silent
      } finally {
        this.pinning = false;
      }
    },

    // ── Add hashtag tab ───────────────────────────────────────────────────────

    async submitHashtagTab() {
      const hashtag = (this.hashtagInput || "").replace(/^#+/, "").trim();
      if (!hashtag) return;

      try {
        const res = await fetch(
          `${this._mountPath}/admin/reader/api/tabs`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": this._csrfToken,
            },
            body: JSON.stringify({ type: "hashtag", hashtag }),
          }
        );

        if (res.status === 409) {
          const existing = this.tabs.find(
            (t) => t.type === "hashtag" && t.hashtag === hashtag
          );
          if (existing) {
            this.switchTab(existing._id);
            this.showHashtagForm = false;
            this.hashtagInput = "";
          }
          return;
        }

        if (res.status === 403) {
          this.error = "Session expired — please refresh the page.";
          return;
        }

        if (!res.ok) return;

        const newTab = await res.json();
        newTab._id = String(newTab._id);
        this.tabs.push(newTab);
        this.hashtagInput = "";
        this.showHashtagForm = false;
        this.switchTab(newTab._id);
      } catch {
        // Network error — silent
      }
    },

    // ── Remove a tab ──────────────────────────────────────────────────────────

    async removeTab(tab) {
      const body =
        tab.type === "instance"
          ? { type: "instance", domain: tab.domain, scope: tab.scope }
          : { type: "hashtag", hashtag: tab.hashtag };

      try {
        const res = await fetch(
          `${this._mountPath}/admin/reader/api/tabs/remove`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": this._csrfToken,
            },
            body: JSON.stringify(body),
          }
        );

        if (res.status === 403) {
          this.error = "Session expired — please refresh the page.";
          return;
        }

        if (!res.ok) return;

        // Clean up tab state
        const { [tab._id]: _removed, ...remaining } = this.tabState;
        this.tabState = remaining;
        this._cacheOrder = this._cacheOrder.filter((id) => id !== tab._id);

        this.tabs = this.tabs
          .filter((t) => t._id !== tab._id)
          .map((t, i) => ({ ...t, order: i }));

        if (this.activeTabId === tab._id) {
          this._teardownScrollObserver();
          this.activeTabId = null;
        }
      } catch {
        // Network error — silent
      }
    },

    // ── Tab reordering ────────────────────────────────────────────────────────

    moveUp(tab) {
      const idx = this.tabs.findIndex((t) => t._id === tab._id);
      if (idx <= 0) return;
      const copy = [...this.tabs];
      [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
      this.tabs = copy.map((t, i) => ({ ...t, order: i }));
      this._scheduleReorder();
    },

    moveDown(tab) {
      const idx = this.tabs.findIndex((t) => t._id === tab._id);
      if (idx < 0 || idx >= this.tabs.length - 1) return;
      const copy = [...this.tabs];
      [copy[idx], copy[idx + 1]] = [copy[idx + 1], copy[idx]];
      this.tabs = copy.map((t, i) => ({ ...t, order: i }));
      this._scheduleReorder();
    },

    _scheduleReorder() {
      if (this._reorderTimer) clearTimeout(this._reorderTimer);
      this._reorderTimer = setTimeout(() => this._sendReorder(), 500);
    },

    async _sendReorder() {
      try {
        const tabIds = this.tabs.map((t) => t._id);
        await fetch(
          `${this._mountPath}/admin/reader/api/tabs/reorder`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": this._csrfToken,
            },
            body: JSON.stringify({ tabIds }),
          }
        );
      } catch {
        // Non-critical — reorder failure doesn't affect UX
      }
    },
  }));
});
