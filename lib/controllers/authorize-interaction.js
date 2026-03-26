/**
 * Authorize Interaction controller — handles the remote follow / authorize
 * interaction flow for ActivityPub federation.
 *
 * Supports:
 * - OStatus subscribe template (legacy remote follow via ?uri=...)
 * - FEP-3b86 Activity Intents (via ?uri=...&intent=follow|create|like|announce)
 *
 * Flow:
 * 1. Missing uri → render error page
 * 2. Unauthenticated → redirect to login, then back here
 * 3. Authenticated → route to appropriate page based on intent
 */

export function authorizeInteractionController(plugin) {
  return async (req, res) => {
    const uri = req.query.uri || req.query.acct;
    const intent = req.query.intent || "";

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
      const params = `uri=${encodeURIComponent(uri)}${intent ? `&intent=${intent}` : ""}`;
      const returnUrl = `${plugin.options.mountPath}/authorize_interaction?${params}`;
      return res.redirect(
        `/session/login?redirect=${encodeURIComponent(returnUrl)}`,
      );
    }

    const mp = plugin.options.mountPath;
    const encodedUrl = encodeURIComponent(resource);

    // Route based on intent (FEP-3b86)
    switch (intent) {
      case "follow":
        return res.redirect(`${mp}/admin/reader/profile?url=${encodedUrl}`);
      case "create":
        return res.redirect(`${mp}/admin/reader/compose?replyTo=${encodedUrl}`);
      case "like":
      case "announce":
        return res.redirect(`${mp}/admin/reader/post?url=${encodedUrl}`);
      default:
        // Default: resolve to remote profile page
        return res.redirect(`${mp}/admin/reader/profile?url=${encodedUrl}`);
    }
  };
}
