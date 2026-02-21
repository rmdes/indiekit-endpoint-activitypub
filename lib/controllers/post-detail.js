// Post detail controller — view individual AP posts/notes/articles
import { Article, Note, Person, Service, Application } from "@fedify/fedify";
import { getToken } from "../csrf.js";
import { extractObjectData } from "../timeline-store.js";
import { getCached, setCache } from "../lookup-cache.js";

// Load parent posts (inReplyTo chain) up to maxDepth levels
async function loadParentChain(ctx, documentLoader, timelineCol, parentUrl, maxDepth = 5) {
  const parents = [];
  let currentUrl = parentUrl;
  let depth = 0;

  while (currentUrl && depth < maxDepth) {
    depth++;

    // Check timeline first
    let parent = timelineCol
      ? await timelineCol.findOne({
          $or: [{ uid: currentUrl }, { url: currentUrl }],
        })
      : null;

    if (!parent) {
      // Fetch via lookupObject
      const cached = getCached(currentUrl);
      let object = cached;

      if (!object) {
        try {
          object = await ctx.lookupObject(new URL(currentUrl), {
            documentLoader,
          });
          if (object) {
            setCache(currentUrl, object);
          }
        } catch {
          break; // Stop on error
        }
      }

      if (!object || !(object instanceof Note || object instanceof Article)) {
        break;
      }

      try {
        parent = await extractObjectData(object);
      } catch {
        break;
      }
    }

    if (parent) {
      parents.unshift(parent); // Add to beginning (chronological order)
      currentUrl = parent.inReplyTo; // Continue up the chain
    } else {
      break;
    }
  }

  return parents;
}

// Load replies collection (best-effort)
async function loadReplies(object, ctx, documentLoader, timelineCol, maxReplies = 10) {
  const replies = [];

  try {
    const repliesCollection = await object.getReplies({ documentLoader });
    if (!repliesCollection) return replies;

    let items = [];
    try {
      items = await repliesCollection.getItems({ documentLoader });
    } catch {
      return replies;
    }

    for (const replyItem of items.slice(0, maxReplies)) {
      try {
        const replyUrl = replyItem.id?.href || replyItem.url?.href;
        if (!replyUrl) continue;

        // Check timeline first
        let reply = timelineCol
          ? await timelineCol.findOne({
              $or: [{ uid: replyUrl }, { url: replyUrl }],
            })
          : null;

        if (!reply) {
          // Extract from the item we already have
          if (replyItem instanceof Note || replyItem instanceof Article) {
            reply = await extractObjectData(replyItem);
          }
        }

        if (reply) {
          replies.push(reply);
        }
      } catch {
        continue; // Skip failed replies
      }
    }
  } catch {
    // getReplies() failed or not available
  }

  return replies;
}

// GET /admin/reader/post — Show post detail view
export function postDetailController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const objectUrl = request.query.url;

      if (!objectUrl || typeof objectUrl !== "string") {
        return response.status(400).render("error", {
          title: "Error",
          content: "Missing post URL",
        });
      }

      // Validate URL format
      try {
        new URL(objectUrl);
      } catch {
        return response.status(400).render("error", {
          title: "Error",
          content: "Invalid post URL",
        });
      }

      if (!plugin._federation) {
        return response.status(503).render("error", {
          title: "Error",
          content: "Federation not initialized",
        });
      }

      const timelineCol = application?.collections?.get("ap_timeline");
      const interactionsCol =
        application?.collections?.get("ap_interactions");

      // Check local timeline first (optimization)
      let timelineItem = null;
      if (timelineCol) {
        timelineItem = await timelineCol.findOne({
          $or: [{ uid: objectUrl }, { url: objectUrl }],
        });
      }

      let object = null;

      if (!timelineItem) {
        // Not in local timeline — fetch via lookupObject
        const handle = plugin.options.actor.handle;
        const ctx = plugin._federation.createContext(
          new URL(plugin._publicationUrl),
          { handle, publicationUrl: plugin._publicationUrl },
        );

        const documentLoader = await ctx.getDocumentLoader({
          identifier: handle,
        });

        // Check cache first
        const cached = getCached(objectUrl);
        if (cached) {
          object = cached;
        } else {
          try {
            object = await ctx.lookupObject(new URL(objectUrl), {
              documentLoader,
            });
            if (object) {
              setCache(objectUrl, object);
            }
          } catch (error) {
            console.warn(
              `[post-detail] lookupObject failed for ${objectUrl}:`,
              error.message,
            );
          }
        }

        if (!object) {
          return response.status(404).render("activitypub-post-detail", {
            title: response.locals.__("activitypub.reader.post.title"),
            notFound: true, objectUrl, mountPath,
            item: null, interactionMap: {}, csrfToken: null,
            parentPosts: [], replyPosts: [],
          });
        }

        // If it's an actor (Person, Service, Application), redirect to profile
        if (
          object instanceof Person ||
          object instanceof Service ||
          object instanceof Application
        ) {
          return response.redirect(
            `${mountPath}/admin/reader/profile?url=${encodeURIComponent(objectUrl)}`,
          );
        }

        // Extract timeline item data from the Fedify object
        if (object instanceof Note || object instanceof Article) {
          try {
            timelineItem = await extractObjectData(object);
          } catch (error) {
            console.error(`[post-detail] extractObjectData failed for ${objectUrl}:`, error.message);
            return response.status(500).render("error", {
              title: "Error",
              content: "Failed to extract post data",
            });
          }
        } else {
          return response.status(400).render("error", {
            title: "Error",
            content: "Object is not a viewable post (must be Note or Article)",
          });
        }
      }

      // Build interaction state for this post
      const interactionMap = {};
      if (interactionsCol && timelineItem) {
        const uid = timelineItem.uid;
        const displayUrl = timelineItem.url || timelineItem.originalUrl;

        const interactions = await interactionsCol
          .find({
            $or: [{ objectUrl: uid }, { objectUrl: displayUrl }],
          })
          .toArray();

        for (const interaction of interactions) {
          const key = uid;
          if (!interactionMap[key]) {
            interactionMap[key] = {};
          }
          interactionMap[key][interaction.type] = true;
        }
      }

      // Load thread (parent chain + replies) with timeout
      let parentPosts = [];
      let replyPosts = [];

      try {
        const handle = plugin.options.actor.handle;
        const ctx = plugin._federation.createContext(
          new URL(plugin._publicationUrl),
          { handle, publicationUrl: plugin._publicationUrl },
        );

        const documentLoader = await ctx.getDocumentLoader({
          identifier: handle,
        });

        const threadPromise = Promise.all([
          // Load parent chain
          timelineItem.inReplyTo
            ? loadParentChain(ctx, documentLoader, timelineCol, timelineItem.inReplyTo)
            : Promise.resolve([]),
          // Load replies (if object is available)
          object
            ? loadReplies(object, ctx, documentLoader, timelineCol)
            : Promise.resolve([]),
        ]);

        // 15-second timeout for thread loading
        const timeout = new Promise((resolve) =>
          setTimeout(() => resolve([[], []]), 15000),
        );

        [parentPosts, replyPosts] = await Promise.race([threadPromise, timeout]);
      } catch (error) {
        console.error("[post-detail] Thread loading failed:", error.message);
        // Continue with empty thread
      }

      const csrfToken = getToken(request.session);

      response.render("activitypub-post-detail", {
        title: response.locals.__("activitypub.reader.post.title"),
        item: timelineItem,
        interactionMap,
        csrfToken,
        mountPath,
        parentPosts,
        replyPosts,
      });
    } catch (error) {
      next(error);
    }
  };
}
