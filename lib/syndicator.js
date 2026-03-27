/**
 * ActivityPub syndicator — delivers posts to followers via Fedify.
 * @module syndicator
 */
import {
  jf2ToAS2Activity,
  parseMentions,
} from "./jf2-to-as2.js";
import { lookupWithSecurity } from "./lookup-helpers.js";
import { logActivity } from "./activity-log.js";
import { addTimelineItem } from "./storage/timeline.js";

/**
 * Create the ActivityPub syndicator object.
 * @param {object} plugin - ActivityPubEndpoint instance
 * @returns {object} Syndicator compatible with Indiekit's syndicator API
 */
export function createSyndicator(plugin) {
  return {
    name: "ActivityPub syndicator",
    options: { checked: plugin.options.checked },

    get info() {
      const hostname = plugin._publicationUrl
        ? new URL(plugin._publicationUrl).hostname
        : "example.com";
      return {
        checked: plugin.options.checked,
        name: `@${plugin.options.actor.handle}@${hostname}`,
        uid: plugin._publicationUrl || "https://example.com/",
        service: {
          name: "ActivityPub (Fediverse)",
          photo: "/assets/@rmdes-indiekit-endpoint-activitypub/icon.svg",
          url: plugin._publicationUrl || "https://example.com/",
        },
      };
    },

    async syndicate(properties) {
      if (!plugin._federation) {
        return undefined;
      }

      try {
        const actorUrl = plugin._getActorUrl();
        const handle = plugin.options.actor.handle;

        const ctx = plugin._federation.createContext(
          new URL(plugin._publicationUrl),
          { handle, publicationUrl: plugin._publicationUrl },
        );

        // For replies, resolve the original post author for proper
        // addressing (CC) and direct inbox delivery
        let replyToActor = null;
        if (properties["in-reply-to"]) {
          try {
            const remoteObject = await lookupWithSecurity(ctx,
              new URL(properties["in-reply-to"]),
            );
            if (remoteObject && typeof remoteObject.getAttributedTo === "function") {
              const author = await remoteObject.getAttributedTo();
              const authorActor = Array.isArray(author) ? author[0] : author;
              if (authorActor?.id) {
                replyToActor = {
                  url: authorActor.id.href,
                  handle: authorActor.preferredUsername || null,
                  recipient: authorActor,
                };
                console.info(
                  `[ActivityPub] Reply to ${properties["in-reply-to"]} — resolved author: ${replyToActor.url}`,
                );
              }
            }
          } catch (error) {
            console.warn(
              `[ActivityPub] Could not resolve reply-to author for ${properties["in-reply-to"]}: ${error.message}`,
            );
          }
        }

        // Resolve @user@domain mentions in content via WebFinger
        const contentText = properties.content?.html || properties.content || "";
        const mentionHandles = parseMentions(contentText);
        const resolvedMentions = [];
        const mentionRecipients = [];

        for (const { handle } of mentionHandles) {
          try {
            const mentionedActor = await lookupWithSecurity(ctx,
              new URL(`acct:${handle}`),
            );
            if (mentionedActor?.id) {
              resolvedMentions.push({
                handle,
                actorUrl: mentionedActor.id.href,
                profileUrl: mentionedActor.url?.href || null,
              });
              mentionRecipients.push({
                handle,
                actorUrl: mentionedActor.id.href,
                actor: mentionedActor,
              });
              console.info(
                `[ActivityPub] Resolved mention @${handle} → ${mentionedActor.id.href}`,
              );
            }
          } catch (error) {
            console.warn(
              `[ActivityPub] Could not resolve mention @${handle}: ${error.message}`,
            );
            // Still add with no actorUrl so it gets a fallback link
            resolvedMentions.push({ handle, actorUrl: null });
          }
        }

        const activity = jf2ToAS2Activity(
          properties,
          actorUrl,
          plugin._publicationUrl,
          {
            replyToActorUrl: replyToActor?.url,
            replyToActorHandle: replyToActor?.handle,
            visibility: plugin.options.defaultVisibility,
            mentions: resolvedMentions,
          },
        );

        if (!activity) {
          await logActivity(plugin._collections.ap_activities, {
            direction: "outbound",
            type: "Syndicate",
            actorUrl: plugin._publicationUrl,
            objectUrl: properties.url,
            summary: `Syndication skipped: could not convert post to AS2`,
          });
          return undefined;
        }

        // Count followers for logging
        const followerCount =
          await plugin._collections.ap_followers.countDocuments();

        console.info(
          `[ActivityPub] Sending ${activity.constructor?.name || "activity"} for ${properties.url} to ${followerCount} followers`,
        );

        // Send to followers via shared inboxes with collection sync (FEP-8fcf)
        await ctx.sendActivity(
          { identifier: handle },
          "followers",
          activity,
          {
            preferSharedInbox: true,
            syncCollection: true,
            orderingKey: properties.url,
          },
        );

        // For replies, also deliver to the original post author's inbox
        // so their server can thread the reply under the original post
        if (replyToActor?.recipient) {
          try {
            await ctx.sendActivity(
              { identifier: handle },
              replyToActor.recipient,
              activity,
              { orderingKey: properties.url },
            );
            console.info(
              `[ActivityPub] Reply delivered to author: ${replyToActor.url}`,
            );
          } catch (error) {
            console.warn(
              `[ActivityPub] Failed to deliver reply to ${replyToActor.url}: ${error.message}`,
            );
          }
        }

        // Deliver to mentioned actors' inboxes (skip reply-to author, already delivered above)
        for (const { handle: mHandle, actorUrl: mUrl, actor: mActor } of mentionRecipients) {
          if (replyToActor?.url === mUrl) continue;
          try {
            await ctx.sendActivity(
              { identifier: handle },
              mActor,
              activity,
              { orderingKey: properties.url },
            );
            console.info(
              `[ActivityPub] Mention delivered to @${mHandle}: ${mUrl}`,
            );
          } catch (error) {
            console.warn(
              `[ActivityPub] Failed to deliver mention to @${mHandle}: ${error.message}`,
            );
          }
        }

        // Determine activity type name
        const typeName =
          activity.constructor?.name || "Create";
        const replyNote = replyToActor
          ? ` (reply to ${replyToActor.url})`
          : "";
        const mentionNote = mentionRecipients.length > 0
          ? ` (mentions: ${mentionRecipients.map(m => `@${m.handle}`).join(", ")})`
          : "";

        await logActivity(plugin._collections.ap_activities, {
          direction: "outbound",
          type: typeName,
          actorUrl: plugin._publicationUrl,
          objectUrl: properties.url,
          targetUrl: properties["in-reply-to"] || undefined,
          summary: `Sent ${typeName} for ${properties.url} to ${followerCount} followers${replyNote}${mentionNote}`,
        });

        console.info(
          `[ActivityPub] Syndication queued: ${typeName} for ${properties.url}${replyNote}`,
        );

        // Add own post to ap_timeline so it appears in Mastodon Client API
        // timelines (Phanpy/Moshidon). Uses $setOnInsert — idempotent.
        try {
          const profile = await plugin._collections.ap_profile?.findOne({});
          const content = buildTimelineContent(properties);
          const timelineItem = {
            uid: properties.url,
            url: properties.url,
            type: mapPostType(properties["post-type"]),
            content,
            author: {
              name: profile?.name || handle,
              url: profile?.url || plugin._publicationUrl,
              photo: profile?.icon || "",
              handle: `@${handle}`,
              emojis: [],
              bot: false,
            },
            published: properties.published || new Date().toISOString(),
            createdAt: new Date().toISOString(),
            visibility: properties.visibility || "public",
            sensitive: properties.sensitive === "true",
            category: Array.isArray(properties.category)
              ? properties.category
              : properties.category ? [properties.category] : [],
            photo: normalizeMedia(properties.photo, plugin._publicationUrl),
            video: normalizeMedia(properties.video, plugin._publicationUrl),
            audio: normalizeMedia(properties.audio, plugin._publicationUrl),
            counts: { replies: 0, boosts: 0, likes: 0 },
          };
          if (properties.name) timelineItem.name = properties.name;
          if (properties.summary) timelineItem.summary = properties.summary;
          if (properties["content-warning"]) {
            timelineItem.summary = properties["content-warning"];
            timelineItem.sensitive = true;
          }
          if (properties["in-reply-to"]) {
            timelineItem.inReplyTo = Array.isArray(properties["in-reply-to"])
              ? properties["in-reply-to"][0]
              : properties["in-reply-to"];
          }
          await addTimelineItem(plugin._collections, timelineItem);
        } catch (tlError) {
          console.warn(
            `[ActivityPub] Failed to add own post to timeline: ${tlError.message}`,
          );
        }

        return properties.url || undefined;
      } catch (error) {
        console.error("[ActivityPub] Syndication failed:", error.message);
        await logActivity(plugin._collections.ap_activities, {
          direction: "outbound",
          type: "Syndicate",
          actorUrl: plugin._publicationUrl,
          objectUrl: properties.url,
          summary: `Syndication failed: ${error.message}`,
        }).catch(() => {});
        return undefined;
      }
    },

    delete: async (url) => plugin.delete(url),
    update: async (properties) => plugin.update(properties),
  };
}

// ─── Timeline helpers ───────────────────────────────────────────────────────

/**
 * Build content from JF2 properties for the ap_timeline entry.
 * For interaction types (likes, bookmarks, reposts), always includes
 * the target URL — even when there's comment text alongside it.
 */
function buildTimelineContent(properties) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Extract any existing body content
  const raw = properties.content;
  let bodyText = "";
  let bodyHtml = "";
  if (raw) {
    if (typeof raw === "string") {
      bodyText = raw;
      bodyHtml = `<p>${raw}</p>`;
    } else {
      bodyText = raw.text || raw.value || "";
      bodyHtml = raw.html || raw.text || raw.value || "";
    }
  }

  // Interaction types: prepend label + target URL, append any comment
  const likeOf = properties["like-of"];
  if (likeOf) {
    const prefix = `Liked: ${likeOf}`;
    const prefixHtml = `<p>Liked: <a href="${esc(likeOf)}">${esc(likeOf)}</a></p>`;
    return {
      text: bodyText ? `${prefix}\n\n${bodyText}` : prefix,
      html: bodyText ? `${prefixHtml}\n${bodyHtml}` : prefixHtml,
    };
  }

  const bookmarkOf = properties["bookmark-of"];
  if (bookmarkOf) {
    const label = properties.name || bookmarkOf;
    const prefix = `Bookmarked: ${label}`;
    const prefixHtml = `<p>Bookmarked: <a href="${esc(bookmarkOf)}">${esc(label)}</a></p>`;
    return {
      text: bodyText ? `${prefix}\n\n${bodyText}` : prefix,
      html: bodyText ? `${prefixHtml}\n${bodyHtml}` : prefixHtml,
    };
  }

  const repostOf = properties["repost-of"];
  if (repostOf) {
    const label = properties.name || repostOf;
    const prefix = `Reposted: ${label}`;
    const prefixHtml = `<p>Reposted: <a href="${esc(repostOf)}">${esc(label)}</a></p>`;
    return {
      text: bodyText ? `${prefix}\n\n${bodyText}` : prefix,
      html: bodyText ? `${prefixHtml}\n${bodyHtml}` : prefixHtml,
    };
  }

  // Regular post — return body content as-is
  if (bodyText || bodyHtml) {
    return { text: bodyText, html: bodyHtml };
  }

  // Article with title but no body
  if (properties.name) {
    return { text: properties.name, html: `<p>${esc(properties.name)}</p>` };
  }

  return { text: "", html: "" };
}

function mapPostType(postType) {
  if (postType === "article") return "article";
  if (postType === "repost") return "boost";
  return "note";
}

function normalizeMedia(value, siteUrl) {
  if (!value) return [];
  const base = siteUrl?.replace(/\/$/, "") || "";
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((item) => {
    if (typeof item === "string") {
      return item.startsWith("http") ? item : `${base}/${item.replace(/^\//, "")}`;
    }
    if (item?.url && !item.url.startsWith("http")) {
      return { ...item, url: `${base}/${item.url.replace(/^\//, "")}` };
    }
    return item;
  }).filter(Boolean);
}
