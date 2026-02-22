/**
 * Compose controllers — reply form via Micropub or direct AP.
 */

import { Temporal } from "@js-temporal/polyfill";
import { getToken, validateToken } from "../csrf.js";
import { sanitizeContent } from "../timeline-store.js";

/**
 * Fetch syndication targets from the Micropub config endpoint.
 * @param {object} application - Indiekit application locals
 * @param {string} token - Session access token
 * @returns {Promise<Array>}
 */
async function getSyndicationTargets(application, token) {
  try {
    const micropubEndpoint = application.micropubEndpoint;

    if (!micropubEndpoint) return [];

    const micropubUrl = micropubEndpoint.startsWith("http")
      ? micropubEndpoint
      : new URL(micropubEndpoint, application.url).href;

    const configUrl = `${micropubUrl}?q=config`;
    const configResponse = await fetch(configUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (configResponse.ok) {
      const config = await configResponse.json();
      return config["syndicate-to"] || [];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * GET /admin/reader/compose — Show compose form.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
export function composeController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const replyTo = request.query.replyTo || "";

      // Fetch reply context (the post being replied to)
      let replyContext = null;

      if (replyTo) {
        const collections = {
          ap_timeline: application?.collections?.get("ap_timeline"),
        };

        // Try to find the post in our timeline first
        // Note: Timeline stores uid (canonical AP URL) and url (display URL).
        // The card link passes the display URL, so search both fields.
        const ap_timeline = collections.ap_timeline;
        replyContext = ap_timeline
          ? await ap_timeline.findOne({ $or: [{ uid: replyTo }, { url: replyTo }] })
          : null;

        // If not in timeline, try to look up remotely
        if (!replyContext && plugin._federation) {
          try {
            const handle = plugin.options.actor.handle;
            const ctx = plugin._federation.createContext(
              new URL(plugin._publicationUrl),
              { handle, publicationUrl: plugin._publicationUrl },
            );
            // Use authenticated document loader for Authorized Fetch
            const documentLoader = await ctx.getDocumentLoader({
              identifier: handle,
            });
            const remoteObject = await ctx.lookupObject(new URL(replyTo), {
              documentLoader,
            });

            if (remoteObject) {
              let authorName = "";
              let authorUrl = "";

              if (typeof remoteObject.getAttributedTo === "function") {
                const author = await remoteObject.getAttributedTo({
                  documentLoader,
                });
                const actor = Array.isArray(author) ? author[0] : author;

                if (actor) {
                  authorName =
                    actor.name?.toString() ||
                    actor.preferredUsername?.toString() ||
                    "";
                  authorUrl = actor.id?.href || "";
                }
              }

              const rawHtml = remoteObject.content?.toString() || "";
              replyContext = {
                url: replyTo,
                name: remoteObject.name?.toString() || "",
                content: {
                  html: sanitizeContent(rawHtml),
                  text: rawHtml.replace(/<[^>]*>/g, "").slice(0, 300),
                },
                author: { name: authorName, url: authorUrl },
              };
            }
          } catch (error) {
            console.warn(
              `[ActivityPub] lookupObject failed for ${replyTo} (compose):`,
              error.message,
            );
          }
        }
      }

      // Fetch syndication targets for Micropub path
      const token = request.session?.access_token;
      const syndicationTargets = token
        ? await getSyndicationTargets(application, token)
        : [];

      // Default-check only AP (Fedify) and Bluesky targets
      // "@rick@rmendes.net" = AP Fedify, "@rmendes.net" = Bluesky
      for (const target of syndicationTargets) {
        const name = target.name || "";
        target.defaultChecked = name === "@rick@rmendes.net" || name === "@rmendes.net";
      }

      const csrfToken = getToken(request.session);

      response.render("activitypub-compose", {
        title: response.locals.__("activitypub.compose.title"),
        replyTo,
        replyContext,
        syndicationTargets,
        csrfToken,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/compose — Submit reply via Micropub or direct AP.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
export function submitComposeController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).render("error", {
          title: "Error",
          content: "Invalid CSRF token",
        });
      }

      const { application } = request.app.locals;
      const { content, mode } = request.body;
      const inReplyTo = request.body["in-reply-to"];
      const syndicateTo = request.body["mp-syndicate-to"];

      if (!content || !content.trim()) {
        return response.status(400).render("error", {
          title: "Error",
          content: response.locals.__("activitypub.compose.errorEmpty"),
        });
      }

      // Quick reply — direct AP
      if (mode === "quick") {
        if (!plugin._federation) {
          return response.status(503).render("error", {
            title: "Error",
            content: "Federation not initialized",
          });
        }

        const { Create, Note } = await import("@fedify/fedify/vocab");
        const handle = plugin.options.actor.handle;
        const ctx = plugin._federation.createContext(
          new URL(plugin._publicationUrl),
          { handle, publicationUrl: plugin._publicationUrl },
        );

        const noteId = `urn:uuid:${crypto.randomUUID()}`;
        const actorUri = ctx.getActorUri(handle);

        const note = new Note({
          id: new URL(noteId),
          attribution: actorUri,
          content: content.trim(),
          inReplyTo: inReplyTo ? new URL(inReplyTo) : undefined,
          published: Temporal.Now.instant(),
        });

        const create = new Create({
          id: new URL(`${noteId}#activity`),
          actor: actorUri,
          object: note,
        });

        // Send to followers
        await ctx.sendActivity({ identifier: handle }, "followers", create, {
          preferSharedInbox: true,
          syncCollection: true,
          orderingKey: noteId,
        });

        // If replying, also send to the original author
        if (inReplyTo) {
          try {
            const documentLoader = await ctx.getDocumentLoader({
              identifier: handle,
            });
            const remoteObject = await ctx.lookupObject(new URL(inReplyTo), {
              documentLoader,
            });

            if (
              remoteObject &&
              typeof remoteObject.getAttributedTo === "function"
            ) {
              const author = await remoteObject.getAttributedTo({
                documentLoader,
              });
              const recipient = Array.isArray(author)
                ? author[0]
                : author;

              if (recipient) {
                await ctx.sendActivity(
                  { identifier: handle },
                  recipient,
                  create,
                  { orderingKey: noteId },
                );
              }
            }
          } catch {
            // Non-critical — followers still got it
          }
        }

        console.info(
          `[ActivityPub] Sent quick reply${inReplyTo ? ` to ${inReplyTo}` : ""}`,
        );

        return response.redirect(`${mountPath}/admin/reader`);
      }

      // Micropub path — post as blog reply
      const micropubEndpoint = application.micropubEndpoint;

      if (!micropubEndpoint) {
        return response.status(500).render("error", {
          title: "Error",
          content: "Micropub endpoint not configured",
        });
      }

      const micropubUrl = micropubEndpoint.startsWith("http")
        ? micropubEndpoint
        : new URL(micropubEndpoint, application.url).href;

      const token = request.session?.access_token;

      if (!token) {
        return response.redirect(
          "/session/login?redirect=" + request.originalUrl,
        );
      }

      const micropubData = new URLSearchParams();
      micropubData.append("h", "entry");
      micropubData.append("content", content.trim());

      if (inReplyTo) {
        micropubData.append("in-reply-to", inReplyTo);
      }

      if (syndicateTo) {
        const targets = Array.isArray(syndicateTo)
          ? syndicateTo
          : [syndicateTo];

        for (const target of targets) {
          micropubData.append("mp-syndicate-to", target);
        }
      }

      const micropubResponse = await fetch(micropubUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: micropubData.toString(),
      });

      if (
        micropubResponse.ok ||
        micropubResponse.status === 201 ||
        micropubResponse.status === 202
      ) {
        const location = micropubResponse.headers.get("Location");
        console.info(
          `[ActivityPub] Created blog reply via Micropub: ${location || "success"}`,
        );

        return response.redirect(`${mountPath}/admin/reader`);
      }

      const errorBody = await micropubResponse.text();
      let errorMessage = `Micropub error: ${micropubResponse.statusText}`;

      try {
        const errorJson = JSON.parse(errorBody);

        if (errorJson.error_description) {
          errorMessage = String(errorJson.error_description);
        } else if (errorJson.error) {
          errorMessage = String(errorJson.error);
        }
      } catch {
        // Not JSON
      }

      return response.status(micropubResponse.status).render("error", {
        title: "Error",
        content: errorMessage,
      });
    } catch (error) {
      console.error("[ActivityPub] Compose submit failed:", error.message);
      return response.status(500).render("error", {
        title: "Error",
        content: "Failed to create post. Please try again later.",
      });
    }
  };
}
