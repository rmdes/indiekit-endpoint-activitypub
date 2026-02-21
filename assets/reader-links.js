/**
 * Client-side AP link interception for internal navigation
 * Redirects ActivityPub links to internal reader views
 */

(function () {
  "use strict";

  // Fediverse URL patterns that should open internally
  const AP_URL_PATTERN =
    /\/@[\w.-]+\/\d+|\/@[\w.-]+\/statuses\/[\w]+|\/users\/[\w.-]+\/statuses\/\d+|\/objects\/[\w-]+|\/notice\/[\w]+|\/notes\/[\w]+|\/post\/\d+|\/comment\/\d+|\/p\/[\w.-]+\/\d+/;

  // Get mount path from DOM
  function getMountPath() {
    // Look for data-mount-path on reader container or header
    const container = document.querySelector(
      "[data-mount-path]",
    );
    return container ? container.dataset.mountPath : "/activitypub";
  }

  // Check if a link should be intercepted
  function shouldInterceptLink(link) {
    const href = link.getAttribute("href");
    if (!href) return null;

    const classes = link.className || "";

    // Mention links → profile view
    if (classes.includes("mention")) {
      return { type: "profile", url: href };
    }

    // AP object URL patterns → post detail view
    if (AP_URL_PATTERN.test(href)) {
      return { type: "post", url: href };
    }

    return null;
  }

  // Handle link click
  function handleLinkClick(event) {
    const link = event.target.closest("a");
    if (!link) return;

    // Only intercept links inside post content
    const contentDiv = link.closest(".ap-card__content");
    if (!contentDiv) return;

    const interception = shouldInterceptLink(link);
    if (!interception) return;

    // Prevent default navigation
    event.preventDefault();

    const mountPath = getMountPath();
    const encodedUrl = encodeURIComponent(interception.url);

    if (interception.type === "profile") {
      window.location.href = `${mountPath}/admin/reader/profile?url=${encodedUrl}`;
    } else if (interception.type === "post") {
      window.location.href = `${mountPath}/admin/reader/post?url=${encodedUrl}`;
    }
  }

  // Initialize on DOM ready
  function init() {
    // Use event delegation on timeline container
    const timeline = document.querySelector(".ap-timeline");
    if (timeline) {
      timeline.addEventListener("click", handleLinkClick);
    }

    // Also set up on post detail view
    const postDetail = document.querySelector(".ap-post-detail");
    if (postDetail) {
      postDetail.addEventListener("click", handleLinkClick);
    }
  }

  // Run on DOMContentLoaded or immediately if already loaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
