/**
 * Media endpoints for Mastodon Client API.
 *
 * POST /api/v2/media — upload media attachment via Micropub media endpoint
 * POST /api/v1/media — legacy upload (same as v2)
 * GET /api/v1/media/:id — get media attachment metadata
 * PUT /api/v1/media/:id — update media metadata (description/focus)
 *
 * File uploads are handled by express-fileupload (configured globally by
 * Indiekit's express.js). Files arrive on req.files, NOT req.file (multer).
 */
import express from "express";
import {
  createAttachment,
  getAttachment,
  updateAttachment,
} from "../../core/media.js";
import { tokenRequired } from "../middleware/token-required.js";
import { scopeRequired } from "../middleware/scope-required.js";

const router = express.Router(); // eslint-disable-line new-cap

/**
 * Determine Mastodon media type from MIME type.
 */
function mediaType(mimeType) {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  return "unknown";
}

/**
 * Serialize an ap_media document to a Mastodon MediaAttachment object.
 */
function serializeMediaAttachment(doc) {
  return {
    id: doc._id.toString(),
    type: mediaType(doc.mimeType),
    url: doc.url,
    preview_url: doc.url,
    remote_url: null,
    text_url: null,
    meta: doc.focus
      ? {
          focus: {
            x: Number.parseFloat(doc.focus.split(",")[0]) || 0,
            y: Number.parseFloat(doc.focus.split(",")[1]) || 0,
          },
        }
      : null,
    description: doc.description || "",
    blurhash: null,
  };
}

/**
 * Upload file to the Micropub media endpoint.
 * Accepts an express-fileupload file object (has .data Buffer, .mimetype, .name).
 * Returns the URL from the Location header.
 */
async function uploadToMediaEndpoint(file, application, token) {
  const mediaEndpoint = application.mediaEndpoint;
  if (!mediaEndpoint) {
    throw new Error("Media endpoint not configured");
  }

  const mediaUrl = mediaEndpoint.startsWith("http")
    ? mediaEndpoint
    : new URL(mediaEndpoint, application.url).href;

  const formData = new FormData();
  const blob = new Blob([file.data], { type: file.mimetype });
  formData.append("file", blob, file.name);

  const response = await fetch(mediaUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Media endpoint returned ${response.status}: ${body}`);
  }

  const location = response.headers.get("Location");
  if (!location) {
    throw new Error("Media endpoint did not return a Location header");
  }

  return location;
}

// ─── POST /api/v2/media ─────────────────────────────────────────────────────

router.post(
  "/api/v2/media",
  tokenRequired,
  scopeRequired("write", "write:media"),
  async (req, res, next) => {
    try {
      const { application } = req.app.locals;
      const collections = req.app.locals.mastodonCollections;
      // Use IndieAuth token stored during OAuth authorization, falling back
      // to session token (native reader) or Mastodon token (won't work for
      // Micropub media endpoint but covers direct internal calls).
      const token =
        req.session?.access_token ||
        req.mastodonToken?.indieauthToken ||
        req.mastodonToken?.accessToken;

      const file = req.files?.file;
      if (!file) {
        return res.status(422).json({ error: "No file provided" });
      }

      if (!token) {
        return res
          .status(401)
          .json({ error: "Authentication required for media upload" });
      }

      const fileUrl = await uploadToMediaEndpoint(file, application, token);

      const doc = await createAttachment(collections, {
        url: fileUrl,
        description: req.body.description,
        focus: req.body.focus,
        mimeType: file.mimetype,
      });

      res.json(serializeMediaAttachment(doc));
    } catch (error) {
      next(error);
    }
  },
);

// ─── POST /api/v1/media (legacy) ────────────────────────────────────────────

router.post(
  "/api/v1/media",
  tokenRequired,
  scopeRequired("write", "write:media"),
  async (req, res, next) => {
    try {
      const { application } = req.app.locals;
      const collections = req.app.locals.mastodonCollections;
      // Use IndieAuth token stored during OAuth authorization, falling back
      // to session token (native reader) or Mastodon token (won't work for
      // Micropub media endpoint but covers direct internal calls).
      const token =
        req.session?.access_token ||
        req.mastodonToken?.indieauthToken ||
        req.mastodonToken?.accessToken;

      const file = req.files?.file;
      if (!file) {
        return res.status(422).json({ error: "No file provided" });
      }

      if (!token) {
        return res
          .status(401)
          .json({ error: "Authentication required for media upload" });
      }

      const fileUrl = await uploadToMediaEndpoint(file, application, token);

      const doc = await createAttachment(collections, {
        url: fileUrl,
        description: req.body.description,
        focus: req.body.focus,
        mimeType: file.mimetype,
      });

      res.json(serializeMediaAttachment(doc));
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /api/v1/media/:id ──────────────────────────────────────────────────

router.get(
  "/api/v1/media/:id",
  tokenRequired,
  scopeRequired("read", "read:statuses"),
  async (req, res, next) => {
    try {
      const collections = req.app.locals.mastodonCollections;

      const doc = await getAttachment(collections, req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "Record not found" });
      }

      res.json(serializeMediaAttachment(doc));
    } catch (error) {
      next(error);
    }
  },
);

// ─── PUT /api/v1/media/:id ──────────────────────────────────────────────────

router.put(
  "/api/v1/media/:id",
  tokenRequired,
  scopeRequired("write", "write:media"),
  async (req, res, next) => {
    try {
      const collections = req.app.locals.mastodonCollections;

      const existing = await getAttachment(collections, req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Record not found" });
      }

      const doc = await updateAttachment(collections, req.params.id, {
        description: req.body.description,
        focus: req.body.focus,
      });

      res.json(serializeMediaAttachment(doc));
    } catch (error) {
      next(error);
    }
  },
);

export default router;
