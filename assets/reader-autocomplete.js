/**
 * Autocomplete — Alpine.js components for FediDB-powered search suggestions.
 * Registers `apInstanceSearch` for the explore page instance input.
 */

document.addEventListener("alpine:init", () => {
  // eslint-disable-next-line no-undef
  Alpine.data("apInstanceSearch", (mountPath) => ({
    query: "",
    suggestions: [],
    showResults: false,
    highlighted: -1,
    abortController: null,

    init() {
      // Pick up server-rendered value (when returning to page with instance already loaded)
      const input = this.$refs.input;
      if (input && input.getAttribute("value")) {
        this.query = input.getAttribute("value");
      }
    },

    // Debounced search triggered by x-on:input
    async search() {
      const q = (this.query || "").trim();
      if (q.length < 2) {
        this.suggestions = [];
        this.showResults = false;
        return;
      }

      // Cancel any in-flight request
      if (this.abortController) {
        this.abortController.abort();
      }
      this.abortController = new AbortController();

      try {
        const res = await fetch(
          `${mountPath}/admin/reader/api/instances?q=${encodeURIComponent(q)}`,
          { signal: this.abortController.signal }
        );
        if (!res.ok) return;

        const data = await res.json();
        // Mark _timelineStatus as undefined (not yet checked)
        this.suggestions = data.map((item) => ({
          ...item,
          _timelineStatus: undefined,
        }));
        this.highlighted = -1;
        this.showResults = this.suggestions.length > 0;

        // Fire timeline support checks in parallel (non-blocking)
        this.checkTimelineSupport();
      } catch (err) {
        if (err.name !== "AbortError") {
          this.suggestions = [];
          this.showResults = false;
        }
      }
    },

    // Check timeline support for each suggestion (background, non-blocking)
    async checkTimelineSupport() {
      const items = [...this.suggestions];
      for (const item of items) {
        // Only check if still in the current suggestions list
        const match = this.suggestions.find((s) => s.domain === item.domain);
        if (!match) continue;

        match._timelineStatus = "checking";

        try {
          const res = await fetch(
            `${mountPath}/admin/reader/api/instance-check?domain=${encodeURIComponent(item.domain)}`
          );
          if (!res.ok) continue;

          const data = await res.json();
          // Update the item in the current suggestions (if still present)
          const current = this.suggestions.find((s) => s.domain === item.domain);
          if (current) {
            current._timelineStatus = data.supported;
          }
        } catch {
          const current = this.suggestions.find((s) => s.domain === item.domain);
          if (current) {
            current._timelineStatus = false;
          }
        }
      }
    },

    selectItem(item) {
      this.query = item.domain;
      this.showResults = false;
      this.suggestions = [];
      this.$refs.input.focus();
    },

    close() {
      this.showResults = false;
      this.highlighted = -1;
    },

    highlightNext() {
      if (!this.showResults || this.suggestions.length === 0) return;
      this.highlighted = (this.highlighted + 1) % this.suggestions.length;
    },

    highlightPrev() {
      if (!this.showResults || this.suggestions.length === 0) return;
      this.highlighted =
        this.highlighted <= 0
          ? this.suggestions.length - 1
          : this.highlighted - 1;
    },

    selectHighlighted(event) {
      if (this.showResults && this.highlighted >= 0 && this.suggestions[this.highlighted]) {
        event.preventDefault();
        this.selectItem(this.suggestions[this.highlighted]);
      }
      // Otherwise let the form submit naturally
    },

    onSubmit() {
      this.close();
    },
  }));

  // eslint-disable-next-line no-undef
  Alpine.data("apPopularAccounts", (mountPath) => ({
    query: "",
    suggestions: [],
    allAccounts: [],
    showResults: false,
    highlighted: -1,
    loaded: false,

    // Load popular accounts on first focus (lazy)
    async loadAccounts() {
      if (this.loaded) return;
      this.loaded = true;

      try {
        const res = await fetch(`${mountPath}/admin/reader/api/popular-accounts`);
        if (!res.ok) return;
        this.allAccounts = await res.json();
      } catch {
        // Non-critical
      }
    },

    // Filter locally from preloaded list
    filterAccounts() {
      const q = (this.query || "").trim().toLowerCase();
      if (q.length < 1 || this.allAccounts.length === 0) {
        this.suggestions = [];
        this.showResults = false;
        return;
      }

      this.suggestions = this.allAccounts
        .filter(
          (a) =>
            a.username.toLowerCase().includes(q) ||
            a.name.toLowerCase().includes(q) ||
            a.domain.toLowerCase().includes(q) ||
            a.handle.toLowerCase().includes(q)
        )
        .slice(0, 8);
      this.highlighted = -1;
      this.showResults = this.suggestions.length > 0;
    },

    selectItem(item) {
      this.query = item.handle;
      this.showResults = false;
      this.suggestions = [];
      this.$refs.input.focus();
    },

    close() {
      this.showResults = false;
      this.highlighted = -1;
    },

    highlightNext() {
      if (!this.showResults || this.suggestions.length === 0) return;
      this.highlighted = (this.highlighted + 1) % this.suggestions.length;
    },

    highlightPrev() {
      if (!this.showResults || this.suggestions.length === 0) return;
      this.highlighted =
        this.highlighted <= 0
          ? this.suggestions.length - 1
          : this.highlighted - 1;
    },

    selectHighlighted(event) {
      if (this.showResults && this.highlighted >= 0 && this.suggestions[this.highlighted]) {
        event.preventDefault();
        this.selectItem(this.suggestions[this.highlighted]);
      }
    },

    onSubmit() {
      this.close();
    },
  }));
});
