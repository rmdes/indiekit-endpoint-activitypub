/**
 * MediaAttachment entity serializer for Mastodon Client API.
 *
 * Converts stored media metadata to Mastodon MediaAttachment shape.
 */

/**
 * Serialize a MediaAttachment entity.
 *
 * @param {object} media - Media document from ap_media collection
 * @returns {object} Mastodon MediaAttachment entity
 */
export function serializeMediaAttachment(media) {
  const type = detectMediaType(media.contentType || media.type || "");

  return {
    id: media._id ? media._id.toString() : media.id || "",
    type,
    url: media.url || "",
    preview_url: media.thumbnailUrl || media.url || "",
    remote_url: null,
    text_url: media.url || "",
    meta: media.meta || {},
    description: media.description || media.alt || null,
    blurhash: media.blurhash || null,
  };
}

/**
 * Map MIME type or simple type string to Mastodon media type.
 */
function detectMediaType(contentType) {
  if (contentType.startsWith("image/") || contentType === "image") return "image";
  if (contentType.startsWith("video/") || contentType === "video") return "video";
  if (contentType.startsWith("audio/") || contentType === "audio") return "audio";
  if (contentType.startsWith("image/gif")) return "gifv";
  return "unknown";
}
