/**
 * Messages controllers — DM inbox, compose, and send.
 * Direct messages bypass Micropub and use Fedify ctx.sendActivity() directly.
 */

import { getToken, validateToken } from "../csrf.js";
import { sanitizeContent } from "../timeline-store.js";
import {
  getMessages,
  getConversationPartners,
  getUnreadMessageCount,
  markMessagesRead,
  markAllMessagesRead,
  clearAllMessages,
  deleteMessage,
  addMessage,
} from "../storage/messages.js";

/**
 * GET /admin/reader/messages — Messages inbox with conversation sidebar.
 * @param {string} mountPath - Plugin mount path
 */
export function messagesController(mountPath) {
  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const collections = {
        ap_messages: application?.collections?.get("ap_messages"),
      };

      const partner = request.query.partner || null;
      const before = request.query.before;
      const limit = Number.parseInt(request.query.limit || "20", 10);

      const options = { before, limit };
      if (partner) {
        options.partner = partner;
      }

      // Get messages + conversation partners + unread count + our profile in parallel
      const profileCol = application?.collections?.get("ap_profile");
      const [result, partners, unreadCount, myProfile] = await Promise.all([
        getMessages(collections, options),
        getConversationPartners(collections),
        getUnreadMessageCount(collections),
        profileCol ? profileCol.findOne({}) : null,
      ]);

      // Auto mark-read when viewing a specific conversation
      if (partner) {
        await markMessagesRead(collections, partner);
      }

      const csrfToken = getToken(request.session);

      response.render("activitypub-messages", {
        title: response.locals.__("activitypub.messages.title"),
        readerParent: { href: `${mountPath}/admin/reader`, text: response.locals.__("activitypub.reader.title") },
        items: result.items,
        before: result.before,
        partners,
        activePartner: partner,
        unreadCount,
        myProfile,
        csrfToken,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * GET /admin/reader/messages/compose — DM compose form.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
export function messageComposeController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      const to = request.query.to || "";
      const replyTo = request.query.replyTo || "";

      // Load reply context if replying to a specific message
      let replyContext = null;
      if (replyTo) {
        const { application } = request.app.locals;
        const messagesCol = application?.collections?.get("ap_messages");
        if (messagesCol) {
          replyContext = await messagesCol.findOne({ uid: replyTo });
        }
      }

      const csrfToken = getToken(request.session);

      response.render("activitypub-message-compose", {
        title: response.locals.__("activitypub.messages.compose"),
        readerParent: { href: `${mountPath}/admin/reader/messages`, text: response.locals.__("activitypub.messages.title") },
        to,
        replyTo,
        replyContext,
        csrfToken,
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/messages/compose — Send a DM via Fedify.
 * Bypasses Micropub — sends Create(Note) directly with DM addressing.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
export function submitMessageController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).redirect(`${mountPath}/admin/reader/messages/compose`);
      }

      const { to, content, replyTo } = request.body;

      if (!to || !to.trim()) {
        return response.status(400).render("activitypub-message-compose", {
          title: response.locals.__("activitypub.messages.compose"),
          readerParent: { href: `${mountPath}/admin/reader/messages`, text: response.locals.__("activitypub.messages.title") },
          to: "",
          replyTo: replyTo || "",
          replyContext: null,
          csrfToken: getToken(request.session),
          mountPath,
          error: response.locals.__("activitypub.messages.errorNoRecipient"),
        });
      }

      if (!content || !content.trim()) {
        return response.status(400).render("activitypub-message-compose", {
          title: response.locals.__("activitypub.messages.compose"),
          readerParent: { href: `${mountPath}/admin/reader/messages`, text: response.locals.__("activitypub.messages.title") },
          to,
          replyTo: replyTo || "",
          replyContext: null,
          csrfToken: getToken(request.session),
          mountPath,
          error: response.locals.__("activitypub.messages.errorEmpty"),
        });
      }

      if (!plugin._federation) {
        return response.status(503).render("activitypub-message-compose", {
          title: response.locals.__("activitypub.messages.compose"),
          readerParent: { href: `${mountPath}/admin/reader/messages`, text: response.locals.__("activitypub.messages.title") },
          to,
          replyTo: replyTo || "",
          replyContext: null,
          csrfToken: getToken(request.session),
          mountPath,
          error: "Federation not initialized",
        });
      }

      const { Create, Note, Mention } = await import("@fedify/fedify/vocab");
      const { Temporal } = await import("@js-temporal/polyfill");
      const handle = plugin.options.actor.handle;
      const ctx = plugin._federation.createContext(
        new URL(plugin._publicationUrl),
        { handle, publicationUrl: plugin._publicationUrl },
      );

      const documentLoader = await ctx.getDocumentLoader({
        identifier: handle,
      });

      // Resolve recipient — accept @user@domain or full URL
      let recipient;
      try {
        const recipientInput = to.trim();
        if (recipientInput.startsWith("http")) {
          recipient = await ctx.lookupObject(recipientInput, { documentLoader });
        } else {
          // Handle @user@domain format
          const handle = recipientInput.replace(/^@/, "");
          recipient = await ctx.lookupObject(handle, { documentLoader });
        }
      } catch {
        recipient = null;
      }

      if (!recipient?.id) {
        return response.status(404).render("activitypub-message-compose", {
          title: response.locals.__("activitypub.messages.compose"),
          readerParent: { href: `${mountPath}/admin/reader/messages`, text: response.locals.__("activitypub.messages.title") },
          to,
          replyTo: replyTo || "",
          replyContext: null,
          csrfToken: getToken(request.session),
          mountPath,
          error: response.locals.__("activitypub.messages.errorRecipientNotFound"),
        });
      }

      // Build Create(Note) with DM addressing — to: recipient only, no PUBLIC_COLLECTION
      const uuid = crypto.randomUUID();
      const baseUrl = plugin._publicationUrl.replace(/\/$/, "");
      const noteId = `${baseUrl}/activitypub/messages/${uuid}`;
      const now = Temporal.Now.instant();

      // Sanitize outbound content — basic paragraph wrapping
      const htmlContent = `<p>${sanitizeContent(content.trim())}</p>`;

      const note = new Note({
        id: new URL(noteId),
        attributedTo: ctx.getActorUri(handle),
        tos: [recipient.id],
        tags: [
          new Mention({
            href: recipient.id,
            name: recipient.preferredUsername
              ? `@${recipient.preferredUsername}`
              : recipient.id.href,
          }),
        ],
        content: htmlContent,
        published: now,
        replyTarget: replyTo ? new URL(replyTo) : null,
      });

      const create = new Create({
        id: new URL(`${noteId}#activity`),
        actor: ctx.getActorUri(handle),
        tos: [recipient.id],
        object: note,
        published: now,
      });

      await ctx.sendActivity({ identifier: handle }, recipient, create, {
        orderingKey: recipient.id.href,
      });

      // Store outbound message locally
      const { application } = request.app.locals;
      const collections = {
        ap_messages: application?.collections?.get("ap_messages"),
      };

      const recipientName = recipient.name?.toString() ||
        recipient.preferredUsername?.toString() ||
        recipient.id.href;
      const recipientHandle = recipient.preferredUsername
        ? `@${recipient.preferredUsername}@${recipient.id.hostname}`
        : recipient.id.href;

      // Get our actor's icon for the outbound message
      const profileCol = application?.collections?.get("ap_profile");
      const profile = profileCol ? await profileCol.findOne({}) : null;

      await addMessage(collections, {
        uid: noteId,
        actorUrl: recipient.id.href,
        actorName: recipientName,
        actorPhoto: recipient.iconUrl?.href || recipient.icon?.url?.href || "",
        actorHandle: recipientHandle,
        content: {
          text: content.trim(),
          html: htmlContent,
        },
        inReplyTo: replyTo || null,
        conversationId: recipient.id.href,
        direction: "outbound",
        published: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });

      console.info(`[ActivityPub] Sent DM to ${recipientName} (${recipient.id.href})`);

      return response.redirect(`${mountPath}/admin/reader/messages?partner=${encodeURIComponent(recipient.id.href)}`);
    } catch (error) {
      console.error("[ActivityPub] DM send failed:", error.message);
      next(error);
    }
  };
}

/**
 * POST /admin/reader/messages/mark-read — Mark all messages as read.
 */
export function markAllMessagesReadController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).redirect(`${mountPath}/admin/reader/messages`);
      }

      const { application } = request.app.locals;
      const collections = {
        ap_messages: application?.collections?.get("ap_messages"),
      };

      await markAllMessagesRead(collections);

      return response.redirect(`${mountPath}/admin/reader/messages`);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/messages/clear — Delete all messages.
 */
export function clearAllMessagesController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).redirect(`${mountPath}/admin/reader/messages`);
      }

      const { application } = request.app.locals;
      const collections = {
        ap_messages: application?.collections?.get("ap_messages"),
      };

      await clearAllMessages(collections);

      return response.redirect(`${mountPath}/admin/reader/messages`);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * POST /admin/reader/messages/delete — Delete a single message.
 */
export function deleteMessageController(mountPath) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { uid } = request.body;

      if (!uid) {
        return response.status(400).json({
          success: false,
          error: "Missing message UID",
        });
      }

      const { application } = request.app.locals;
      const collections = {
        ap_messages: application?.collections?.get("ap_messages"),
      };

      await deleteMessage(collections, uid);

      // Support both JSON (fetch) and form redirect
      if (request.headers.accept?.includes("application/json")) {
        return response.json({ success: true, uid });
      }

      return response.redirect(`${mountPath}/admin/reader/messages`);
    } catch (error) {
      next(error);
    }
  };
}
