/**
 * My Profile controller — admin view of own profile and outbound activity.
 * Shows profile header + tabbed activity (posts, replies, likes, boosts).
 */

import { getToken } from "../csrf.js";

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
    category: props.category || [],
  };
}

/**
 * Enrich interaction records (likes/boosts) with timeline data.
 * Returns card items sorted by interaction date.
 */
async function enrichInteractions(interactions, apTimeline) {
  if (!interactions.length) return [];

  const urls = interactions.map((i) => i.objectUrl);
  const timelinePosts = apTimeline
    ? await apTimeline.find({ uid: { $in: urls } }).toArray()
    : [];
  const postMap = new Map(timelinePosts.map((p) => [p.uid, p]));

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
      const collections = application.collections;

      const tab = VALID_TABS.includes(request.query.tab)
        ? request.query.tab
        : "posts";
      const before = request.query.before;

      // Profile header data (parallel)
      const apProfile = collections.get("ap_profile");
      const apFollowers = collections.get("ap_followers");
      const apFollowing = collections.get("ap_following");
      const postsCollection = collections.get("posts");

      const [profile, followerCount, followingCount, postCount] =
        await Promise.all([
          apProfile ? apProfile.findOne({}) : null,
          apFollowers ? apFollowers.countDocuments() : 0,
          apFollowing ? apFollowing.countDocuments() : 0,
          postsCollection ? postsCollection.countDocuments() : 0,
        ]);

      const domain = new URL(plugin._publicationUrl).hostname;
      const handle = plugin.options.actor.handle;

      // Tab data
      let items = [];
      let nextBefore = null;

      switch (tab) {
        case "posts": {
          const query = {};
          if (before) {
            query["properties.published"] = { $lt: before };
          }

          const posts = postsCollection
            ? await postsCollection
                .find(query)
                .sort({ "properties.published": -1 })
                .limit(PAGE_LIMIT)
                .toArray()
            : [];

          items = posts.map((p) => postToCardItem(p, profile));

          if (posts.length === PAGE_LIMIT) {
            nextBefore = items[items.length - 1].published;
          }
          break;
        }

        case "replies": {
          // Query posts collection for reply-type posts (have in-reply-to)
          if (postsCollection) {
            const query = {
              "properties.post-type": "reply",
            };
            if (before) {
              query["properties.published"] = { $lt: before };
            }

            const replies = await postsCollection
              .find(query)
              .sort({ "properties.published": -1 })
              .limit(PAGE_LIMIT)
              .toArray();

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

        case "likes": {
          const apInteractions = collections.get("ap_interactions");
          const apTimeline = collections.get("ap_timeline");
          if (apInteractions) {
            const query = { type: "like" };
            if (before) {
              query.createdAt = { $lt: before };
            }

            const likes = await apInteractions
              .find(query)
              .sort({ createdAt: -1 })
              .limit(PAGE_LIMIT)
              .toArray();

            items = await enrichInteractions(likes, apTimeline);

            if (likes.length === PAGE_LIMIT) {
              nextBefore = likes[likes.length - 1].createdAt;
            }
          }
          break;
        }

        case "boosts": {
          const apInteractions = collections.get("ap_interactions");
          const apTimeline = collections.get("ap_timeline");
          if (apInteractions) {
            const query = { type: "boost" };
            if (before) {
              query.createdAt = { $lt: before };
            }

            const boosts = await apInteractions
              .find(query)
              .sort({ createdAt: -1 })
              .limit(PAGE_LIMIT)
              .toArray();

            items = await enrichInteractions(boosts, apTimeline);

            if (boosts.length === PAGE_LIMIT) {
              nextBefore = boosts[boosts.length - 1].createdAt;
            }
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
