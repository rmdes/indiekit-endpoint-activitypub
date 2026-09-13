/**
 * My Profile controller — admin view of own profile and outbound activity.
 * Shows profile header + tabbed activity (posts, replies, likes, boosts).
 */

import { getToken } from "../csrf.js";
import { getAccountCounts, getProfile } from "../core/profile.js";
import { countOwnPosts, getOwnPosts } from "../core/posts.js";
import { getInteractionsBefore } from "../core/interactions.js";
import { getItemsByUrls } from "../core/timeline.js";

const VALID_TABS = ["posts", "replies", "likes", "boosts"];
const PAGE_LIMIT = 20;

/**
 * Normalize a JF2 post from the Indiekit `posts` collection into the
 * shape expected by the ap-item-card.njk partial.
 */
function postToCardItem(post, profile) {
  const props = post.properties || {};
  const contentProp = props.content;
  const content =
    typeof contentProp === "string" ? { text: contentProp } : contentProp || {};

  // Normalize photo to array of { url } objects
  let photo = [];
  if (props.photo) {
    const photos = Array.isArray(props.photo) ? props.photo : [props.photo];
    photo = photos.map((p) => (typeof p === "string" ? { url: p } : p));
  }

  return {
    uid: props.url,
    url: props.url,
    name: props.name || "",
    content,
    published: props.published,
    type: props["post-type"] || "note",
    author: {
      name: profile?.name || "",
      url: profile?.url || "",
      photo: profile?.icon || "",
    },
    photo,
    category: Array.isArray(props.category)
      ? props.category
      : props.category
        ? [props.category]
        : [],
  };
}

/**
 * Enrich interaction records (likes/boosts) with timeline data.
 * Returns card items sorted by interaction date.
 */
async function enrichInteractions(interactions, collections) {
  if (!interactions.length) return [];

  const postMap = await getItemsByUrls(
    collections,
    interactions.map((i) => i.objectUrl),
  );

  return interactions.map((interaction) => {
    const post = postMap.get(interaction.objectUrl);
    if (post) {
      return {
        ...post,
        published:
          post.published instanceof Date
            ? post.published.toISOString()
            : post.published,
        _interactionDate: interaction.createdAt,
      };
    }
    // Fallback: minimal card with just the URL
    return {
      uid: interaction.objectUrl,
      url: interaction.objectUrl,
      content: { text: interaction.objectUrl },
      published: interaction.createdAt,
      type: "note",
      author: { name: "", url: "", photo: "" },
    };
  });
}

export function myProfileController(plugin) {
  const mountPath = plugin.options.mountPath;

  return async (request, response, next) => {
    try {
      const { application } = request.app.locals;
      const get = (name) => application.collections.get(name);
      const collections = {
        ap_profile: get("ap_profile"),
        ap_followers: get("ap_followers"),
        ap_following: get("ap_following"),
        ap_interactions: get("ap_interactions"),
        ap_timeline: get("ap_timeline"),
        posts: get("posts"),
      };

      const tab = VALID_TABS.includes(request.query.tab)
        ? request.query.tab
        : "posts";
      const before = request.query.before;

      // Profile header data (parallel)
      const [profile, counts, postCount] = await Promise.all([
        getProfile(collections),
        getAccountCounts(collections),
        countOwnPosts(collections),
      ]);
      const followerCount = counts.followers;
      const followingCount = counts.following;

      const domain = new URL(plugin._publicationUrl).hostname;
      const handle = plugin.options.actor.handle;

      // Tab data
      let items = [];
      let nextBefore = null;

      switch (tab) {
        case "posts": {
          const posts = await getOwnPosts(collections, { before, limit: PAGE_LIMIT });

          items = posts.map((p) => postToCardItem(p, profile));

          if (posts.length === PAGE_LIMIT) {
            nextBefore = items[items.length - 1].published;
          }
          break;
        }

        case "replies": {
          // Query posts collection for reply-type posts (have in-reply-to)
          {
            const replies = await getOwnPosts(collections, {
              before,
              limit: PAGE_LIMIT,
              postType: "reply",
            });

            items = replies.map((p) => {
              const card = postToCardItem(p, profile);
              card.inReplyTo = p.properties?.["in-reply-to"] || null;
              card.type = "reply";
              return card;
            });

            if (replies.length === PAGE_LIMIT) {
              nextBefore = items[items.length - 1].published;
            }
          }
          break;
        }

        case "likes":
        case "boosts": {
          const type = tab === "likes" ? "like" : "boost";
          const rows = await getInteractionsBefore(collections, type, {
            before,
            limit: PAGE_LIMIT,
          });

          items = await enrichInteractions(rows, collections);

          if (rows.length === PAGE_LIMIT) {
            nextBefore = rows[rows.length - 1].createdAt;
          }
          break;
        }
      }

      const csrfToken = getToken(request.session);

      response.render("activitypub-my-profile", {
        title: response.locals.__("activitypub.myProfile.title"),
        readerParent: { href: mountPath, text: response.locals.__("activitypub.title") },
        profile: profile || {},
        handle,
        domain,
        fullHandle: `@${handle}@${domain}`,
        followerCount,
        followingCount,
        postCount,
        tab,
        items,
        before: nextBefore,
        csrfToken,
        interactionMap: {},
        mountPath,
      });
    } catch (error) {
      next(error);
    }
  };
}
