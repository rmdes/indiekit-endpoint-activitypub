/**
 * Media endpoints for Mastodon Client API.
 *
 * POST /api/v2/media — upload media attachment (stub — returns 422 until storage is configured)
 * POST /api/v1/media — legacy upload endpoint (redirects to v2)
 * GET /api/v1/media/:id — get media attachment status
 * PUT /api/v1/media/:id — update media metadata (description/focus)
 */
import express from "express";

const router = express.Router(); // eslint-disable-line new-cap

// ─── POST /api/v2/media ─────────────────────────────────────────────────────

router.post("/api/v2/media", (req, res) => {
  // Media upload requires multer/multipart handling + storage backend.
  // For now, return 422 so clients show a user-friendly error.
  res.status(422).json({
    error: "Media uploads are not yet supported on this server",
  });
});

// ─── POST /api/v1/media (legacy) ────────────────────────────────────────────

router.post("/api/v1/media", (req, res) => {
  res.status(422).json({
    error: "Media uploads are not yet supported on this server",
  });
});

// ─── GET /api/v1/media/:id ──────────────────────────────────────────────────

router.get("/api/v1/media/:id", (req, res) => {
  res.status(404).json({ error: "Record not found" });
});

// ─── PUT /api/v1/media/:id ──────────────────────────────────────────────────

router.put("/api/v1/media/:id", (req, res) => {
  res.status(404).json({ error: "Record not found" });
});

export default router;
