/**
 * Resolve controller — accepts any fediverse URL or handle, resolves it
 * via lookupObject(), and redirects to the appropriate internal view.
 */
import {
  Article,
  Note,
  Person,
  Service,
  Application,
  Organization,
  Group,
} from "@fedify/fedify";

/**
 * GET /admin/reader/resolve?q=<url-or-handle>
 * Resolves a fediverse URL or @user@domain handle and redirects to
 * the post detail or remote profile view.
 */
export function resolveController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const query = (request.query.q || "").trim();

      if (!query) {
        return response.redirect(`${mountPath}/admin/reader`);
      }

      if (!plugin._federation) {
        return response.status(503).render("error", {
          title: "Error",
          content: "Federation not initialized",
        });
      }

      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });

      // Determine if input is a URL or a handle
      // lookupObject accepts: URLs, @user@domain, user@domain, acct:user@domain
      let lookupInput;

      try {
        // If it parses as a URL, pass as URL object
        const parsed = new URL(query);
        lookupInput = parsed;
      } catch {
        // Not a URL — treat as handle (strip leading @ if present)
        lookupInput = query;
      }

      let object;

      try {
        object = await ctx.lookupObject(lookupInput, { documentLoader });
      } catch (error) {
        console.warn(
          `[resolve] lookupObject failed for "${query}":`,
          error.message,
        );
      }

      if (!object) {
        return response.status(404).render("error", {
          title: response.locals.__("activitypub.reader.resolve.notFoundTitle"),
          content: response.locals.__(
            "activitypub.reader.resolve.notFound",
          ),
        });
      }

      // Determine object type and redirect accordingly
      const objectUrl =
        object.id?.href || object.url?.href || query;

      if (
        object instanceof Person ||
        object instanceof Service ||
        object instanceof Application ||
        object instanceof Organization ||
        object instanceof Group
      ) {
        return response.redirect(
          `${mountPath}/admin/reader/profile?url=${encodeURIComponent(objectUrl)}`,
        );
      }

      if (object instanceof Note || object instanceof Article) {
        return response.redirect(
          `${mountPath}/admin/reader/post?url=${encodeURIComponent(objectUrl)}`,
        );
      }

      // Unknown type — try post detail as fallback
      return response.redirect(
        `${mountPath}/admin/reader/post?url=${encodeURIComponent(objectUrl)}`,
      );
    } catch (error) {
      next(error);
    }
  };
}
