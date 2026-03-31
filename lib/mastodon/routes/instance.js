/**
 * Instance info endpoints for Mastodon Client API.
 *
 * GET /api/v2/instance — v2 format (primary)
 * GET /api/v1/instance — v1 format (fallback for older clients)
 */
import express from "express";
import { serializeAccount } from "../entities/account.js";

const router = express.Router(); // eslint-disable-line new-cap

// ─── GET /api/v2/instance ────────────────────────────────────────────────────

router.get("/api/v2/instance", async (req, res, next) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const domain = req.get("host");
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const apSettings = req.app.locals.apSettings;

    const profile = await collections.ap_profile.findOne({});
    const contactAccount = profile
      ? serializeAccount(profile, {
          baseUrl,
          isLocal: true,
          handle: pluginOptions.handle || "user",
        })
      : null;

    res.json({
      domain,
      title: profile?.name || domain,
      version: "4.0.0 (compatible; Indiekit ActivityPub)",
      source_url: "https://github.com/getindiekit/indiekit",
      description: profile?.summary || `An Indiekit instance at ${domain}`,
      usage: {
        users: {
          active_month: 1,
        },
      },
      thumbnail: {
        url: profile?.icon || `${baseUrl}/favicon.ico`,
        blurhash: null,
        versions: {},
      },
      icon: [],
      languages: apSettings?.instanceLanguages || ["en"],
      configuration: {
        urls: {
          streaming: "",
        },
        accounts: {
          max_featured_tags: 10,
          max_pinned_statuses: 10,
        },
        statuses: {
          max_characters: apSettings?.maxCharacters || 5000,
          max_media_attachments: apSettings?.maxMediaAttachments || 4,
          characters_reserved_per_url: 23,
        },
        media_attachments: {
          supported_mime_types: [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
            "video/mp4",
            "video/webm",
            "audio/mpeg",
            "audio/ogg",
          ],
          image_size_limit: 16_777_216,
          image_matrix_limit: 16_777_216,
          video_size_limit: 67_108_864,
          video_frame_rate_limit: 60,
          video_matrix_limit: 16_777_216,
        },
        polls: {
          max_options: 4,
          max_characters_per_option: 50,
          min_expiration: 300,
          max_expiration: 2_592_000,
        },
        translation: {
          enabled: false,
        },
        vapid: {
          public_key: "",
        },
      },
      registrations: {
        enabled: false,
        approval_required: true,
        message: null,
        url: null,
      },
      api_versions: {
        mastodon: 0,
      },
      contact: {
        email: "",
        account: contactAccount,
      },
      rules: [],
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/v1/instance ────────────────────────────────────────────────────

router.get("/api/v1/instance", async (req, res, next) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const domain = req.get("host");
    const collections = req.app.locals.mastodonCollections;
    const pluginOptions = req.app.locals.mastodonPluginOptions || {};
    const apSettings = req.app.locals.apSettings;

    const profile = await collections.ap_profile.findOne({});

    // Get approximate counts
    let statusCount = 0;
    let domainCount = 0;
    try {
      statusCount = await collections.ap_timeline.countDocuments({});
      // Rough domain count from unique follower domains
      const followers = await collections.ap_followers
        .find({}, { projection: { actorUrl: 1 } })
        .toArray();
      const domains = new Set(
        followers
          .map((f) => {
            try {
              return new URL(f.actorUrl).hostname;
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      );
      domainCount = domains.size;
    } catch {
      // Non-critical
    }

    res.json({
      uri: domain,
      title: profile?.name || domain,
      short_description: profile?.summary || "",
      description: profile?.summary || `An Indiekit instance at ${domain}`,
      email: "",
      version: "4.0.0 (compatible; Indiekit ActivityPub)",
      urls: {
        streaming_api: "",
      },
      stats: {
        user_count: 1,
        status_count: statusCount,
        domain_count: domainCount,
      },
      thumbnail: profile?.icon || null,
      languages: apSettings?.instanceLanguages || ["en"],
      registrations: false,
      approval_required: true,
      invites_enabled: false,
      configuration: {
        statuses: {
          max_characters: apSettings?.maxCharacters || 5000,
          max_media_attachments: apSettings?.maxMediaAttachments || 4,
          characters_reserved_per_url: 23,
        },
        media_attachments: {
          supported_mime_types: [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
          ],
          image_size_limit: 16_777_216,
          image_matrix_limit: 16_777_216,
          video_size_limit: 67_108_864,
          video_frame_rate_limit: 60,
          video_matrix_limit: 16_777_216,
        },
        polls: {
          max_options: 4,
          max_characters_per_option: 50,
          min_expiration: 300,
          max_expiration: 2_592_000,
        },
      },
      contact_account: profile
        ? serializeAccount(profile, {
            baseUrl,
            isLocal: true,
            handle: pluginOptions.handle || "user",
          })
        : null,
      rules: [],
    });
  } catch (error) {
    next(error);
  }
});

export default router;
