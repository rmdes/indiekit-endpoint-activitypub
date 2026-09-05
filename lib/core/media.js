/**
 * Media-attachment domain logic.
 *
 * `ap_media` records attachments that have been uploaded but not yet attached
 * to a post: a client uploads first, gets an id back, then references that id
 * when composing. The bytes live wherever the media endpoint put them; this
 * collection holds the URL and the metadata a client can still edit
 * (description, focal point).
 *
 * Worth having in core beyond the boundary rule: media upload is one of the
 * unwritten pieces of extended C2S, so a C2S adapter will need exactly these
 * operations rather than a Mastodon-shaped route.
 *
 * @module core/media
 */
import { decodeCursor } from "./cursor.js";

/**
 * Record an uploaded attachment.
 *
 * @param {object} collections
 * @param {object} attachment - { url, description, focus, mimeType }
 * @returns {Promise<object|null>} the stored document
 */
export async function createAttachment(collections, attachment) {
  if (!collections.ap_media) return null;

  const doc = {
    url: attachment.url,
    description: attachment.description || "",
    focus: attachment.focus || null,
    mimeType: attachment.mimeType || "",
    createdAt: new Date(),
  };

  const { insertedId } = await collections.ap_media.insertOne(doc);

  return { ...doc, _id: insertedId };
}

/**
 * One attachment by its opaque id.
 *
 * Returns null for a malformed id rather than throwing — that is a 404.
 *
 * @param {object} collections
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getAttachment(collections, id) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_media) return null;

  return collections.ap_media.findOne({ _id: objectId });
}

/**
 * Update the client-editable metadata on an attachment.
 *
 * Only description and focus are editable — the URL and MIME type are set by
 * the upload and changing them would decouple the record from its bytes.
 *
 * @param {object} collections
 * @param {string} id
 * @param {{description?: string, focus?: string}} updates
 * @returns {Promise<object|null>} the updated document
 */
export async function updateAttachment(collections, id, updates) {
  const objectId = decodeCursor(id);
  if (!objectId || !collections.ap_media) return null;

  const update = {};
  if (updates.description !== undefined) update.description = updates.description;
  if (updates.focus !== undefined) update.focus = updates.focus;

  if (Object.keys(update).length > 0) {
    await collections.ap_media.updateOne({ _id: objectId }, { $set: update });
  }

  return collections.ap_media.findOne({ _id: objectId });
}
