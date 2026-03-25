/**
 * Card interaction Alpine.js component.
 * Handles like, boost, and save-for-later actions with optimistic UI and
 * rollback on failure.
 *
 * Configured via data-* attributes on the container element (the <footer>):
 *   data-item-uid="..."        canonical AP UID used for like/boost API calls
 *   data-item-url="..."        display URL used for saveLater and links
 *   data-csrf-token="..."
 *   data-mount-path="..."
 *   data-liked="true|false"
 *   data-boosted="true|false"
 *   data-like-count="N"        omit or empty string for null
 *   data-boost-count="N"       omit or empty string for null
 */
document.addEventListener("alpine:init", () => {
  Alpine.data("apCardInteraction", () => ({
    liked: false,
    boosted: false,
    saved: false,
    loading: false,
    error: "",
    likeCount: null,
    boostCount: null,

    // Stored from data attributes in init() — must use $root to guarantee
    // we read from the x-data element, not a child element in event context.
    _mountPath: "",
    _csrfToken: "",
    _itemUid: "",
    _itemUrl: "",

    init() {
      const root = this.$root;
      this.liked = root.dataset.liked === "true";
      this.boosted = root.dataset.boosted === "true";
      this._mountPath = root.dataset.mountPath || "";
      this._csrfToken = root.dataset.csrfToken || "";
      this._itemUid = root.dataset.itemUid || "";
      this._itemUrl = root.dataset.itemUrl || "";
      const lc = root.dataset.likeCount;
      const bc = root.dataset.boostCount;
      this.likeCount = lc != null && lc !== "" ? Number(lc) : null;
      this.boostCount = bc != null && bc !== "" ? Number(bc) : null;
    },

    async saveLater() {
      if (this.saved) return;
      const itemUrl = this._itemUrl;
      try {
        const res = await fetch("/readlater/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: itemUrl,
            title:
              this.$root.closest("article")?.querySelector("p")?.textContent?.substring(0, 80) ||
              itemUrl,
            source: "activitypub",
          }),
          credentials: "same-origin",
        });
        if (res.ok) this.saved = true;
        else this.error = "Failed to save";
      } catch (e) {
        this.error = e.message;
      }
      if (this.error) setTimeout(() => (this.error = ""), 3000);
    },

    async interact(action) {
      if (this.loading) return;
      this.loading = true;
      this.error = "";
      const itemUid = this._itemUid;
      const csrfToken = this._csrfToken;
      const basePath = this._mountPath;
      const prev = {
        liked: this.liked,
        boosted: this.boosted,
        boostCount: this.boostCount,
        likeCount: this.likeCount,
      };
      if (action === "like") {
        this.liked = true;
        if (this.likeCount !== null) this.likeCount++;
      } else if (action === "unlike") {
        this.liked = false;
        if (this.likeCount !== null && this.likeCount > 0) this.likeCount--;
      } else if (action === "boost") {
        this.boosted = true;
        if (this.boostCount !== null) this.boostCount++;
      } else if (action === "unboost") {
        this.boosted = false;
        if (this.boostCount !== null && this.boostCount > 0) this.boostCount--;
      }
      try {
        const res = await fetch(basePath + "/admin/reader/" + action, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ url: itemUid }),
        });
        const data = await res.json();
        if (!data.success) {
          this.liked = prev.liked;
          this.boosted = prev.boosted;
          this.boostCount = prev.boostCount;
          this.likeCount = prev.likeCount;
          this.error = data.error || "Failed";
        }
      } catch (e) {
        this.liked = prev.liked;
        this.boosted = prev.boosted;
        this.boostCount = prev.boostCount;
        this.likeCount = prev.likeCount;
        this.error = e.message;
      }
      this.loading = false;
      if (this.error) setTimeout(() => (this.error = ""), 3000);
    },
  }));
});
