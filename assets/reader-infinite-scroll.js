/**
 * Infinite scroll — AlpineJS component for AJAX load-more on the timeline
 * Registers the `apInfiniteScroll` Alpine data component.
 */

document.addEventListener("alpine:init", () => {
  // eslint-disable-next-line no-undef
  Alpine.data("apExploreScroll", () => ({
    loading: false,
    done: false,
    maxId: null,
    instance: "",
    scope: "local",
    observer: null,

    init() {
      const el = this.$el;
      this.maxId = el.dataset.maxId || null;
      this.instance = el.dataset.instance || "";
      this.scope = el.dataset.scope || "local";

      if (!this.maxId) {
        this.done = true;
        return;
      }

      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.loading && !this.done) {
              this.loadMore();
            }
          }
        },
        { rootMargin: "200px" }
      );

      if (this.$refs.sentinel) {
        this.observer.observe(this.$refs.sentinel);
      }
    },

    async loadMore() {
      if (this.loading || this.done || !this.maxId) return;

      this.loading = true;

      const timeline = document.getElementById("ap-explore-timeline");
      const mountPath = timeline ? timeline.dataset.mountPath : "";

      const params = new URLSearchParams({
        instance: this.instance,
        scope: this.scope,
        max_id: this.maxId,
      });

      try {
        const res = await fetch(
          `${mountPath}/admin/reader/api/explore?${params.toString()}`,
          { headers: { Accept: "application/json" } }
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        if (data.html && timeline) {
          timeline.insertAdjacentHTML("beforeend", data.html);
        }

        if (data.maxId) {
          this.maxId = data.maxId;
        } else {
          this.done = true;
          if (this.observer) this.observer.disconnect();
        }
      } catch (err) {
        console.error("[ap-explore-scroll] load failed:", err.message);
      } finally {
        this.loading = false;
      }
    },

    destroy() {
      if (this.observer) this.observer.disconnect();
    },
  }));

  // eslint-disable-next-line no-undef
  Alpine.data("apInfiniteScroll", () => ({
    loading: false,
    done: false,
    before: null,
    tab: "",
    tag: "",
    observer: null,

    init() {
      const el = this.$el;
      this.before = el.dataset.before || null;
      this.tab = el.dataset.tab || "";
      this.tag = el.dataset.tag || "";

      // Hide the no-JS pagination fallback now that JS is active
      const paginationEl =
        document.getElementById("ap-reader-pagination") ||
        document.getElementById("ap-tag-pagination");
      if (paginationEl) {
        paginationEl.style.display = "none";
      }

      if (!this.before) {
        this.done = true;
        return;
      }

      // Set up IntersectionObserver to auto-load when sentinel comes into view
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.loading && !this.done) {
              this.loadMore();
            }
          }
        },
        { rootMargin: "200px" }
      );

      if (this.$refs.sentinel) {
        this.observer.observe(this.$refs.sentinel);
      }
    },

    async loadMore() {
      if (this.loading || this.done || !this.before) return;

      this.loading = true;

      const timeline = document.getElementById("ap-timeline");
      const mountPath = timeline ? timeline.dataset.mountPath : "";

      const params = new URLSearchParams({ before: this.before });
      if (this.tab) params.set("tab", this.tab);
      if (this.tag) params.set("tag", this.tag);

      try {
        const res = await fetch(
          `${mountPath}/admin/reader/api/timeline?${params.toString()}`,
          { headers: { Accept: "application/json" } }
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        if (data.html && timeline) {
          // Append the returned pre-rendered HTML
          timeline.insertAdjacentHTML("beforeend", data.html);
        }

        if (data.before) {
          this.before = data.before;
        } else {
          // No more items
          this.done = true;
          if (this.observer) this.observer.disconnect();
        }
      } catch (err) {
        console.error("[ap-infinite-scroll] load failed:", err.message);
      } finally {
        this.loading = false;
      }
    },

    appendItems(/* detail */) {
      // Custom event hook — not used in this implementation but kept for extensibility
    },

    destroy() {
      if (this.observer) this.observer.disconnect();
    },
  }));
});
