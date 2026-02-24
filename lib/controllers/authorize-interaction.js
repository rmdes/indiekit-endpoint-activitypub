/**
 * Authorize Interaction controller — handles the remote follow / authorize
 * interaction flow for ActivityPub federation.
 *
 * When a remote server (WordPress AP, Misskey, etc.) discovers our WebFinger
 * subscribe template, it redirects the user here with ?uri={actorOrPostUrl}.
 *
 * Flow:
 * 1. Missing uri → render error page
 * 2. Unauthenticated → redirect to login, then back here
 * 3. Authenticated → redirect to the reader's remote profile page
 */

export function authorizeInteractionController(plugin) {
  return async (req, res) => {
    const uri = req.query.uri || req.query.acct;
    if (!uri) {
      return res.status(400).render("activitypub-authorize-interaction", {
        title: "Authorize Interaction",
        mountPath: plugin.options.mountPath,
        error: "Missing uri parameter",
      });
    }

    // Clean up acct: prefix if present
    const resource = uri.replace(/^acct:/, "");

    // Check authentication — if not logged in, redirect to login
    // then back to this page after auth
    const session = req.session;
    if (!session?.access_token) {
      const returnUrl = `${plugin.options.mountPath}/authorize_interaction?uri=${encodeURIComponent(uri)}`;
      return res.redirect(
        `/session/login?redirect=${encodeURIComponent(returnUrl)}`,
      );
    }

    // Authenticated — redirect to the remote profile viewer in our reader
    // which already has follow/unfollow/like/boost functionality
    const encodedUrl = encodeURIComponent(resource);
    return res.redirect(
      `${plugin.options.mountPath}/admin/reader/profile?url=${encodedUrl}`,
    );
  };
}
