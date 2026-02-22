/**
 * Public route handler for serving quick reply Notes as ActivityPub JSON-LD.
 *
 * Remote servers dereference Note IDs to verify Create activities.
 * Without this, quick replies are rejected by servers that validate
 * the Note's ID URL (Mastodon with Authorized Fetch, Bonfire, etc.).
 */

/**
 * GET /quick-replies/:id — serve a stored Note as JSON-LD.
 * @param {object} plugin - ActivityPub plugin instance
 */
export function noteObjectController(plugin) {
  return async (request, response) => {
    const { id } = request.params;

    const { application } = request.app.locals;
    const ap_notes = application?.collections?.get("ap_notes");

    if (!ap_notes) {
      return response.status(404).json({ error: "Not Found" });
    }

    const note = await ap_notes.findOne({ _id: id });

    if (!note) {
      return response.status(404).json({ error: "Not Found" });
    }

    const noteJson = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: note.noteId,
      type: "Note",
      attributedTo: note.actorUrl,
      content: note.content,
      published: note.published,
      to: note.to,
      cc: note.cc,
    };

    if (note.inReplyTo) {
      noteJson.inReplyTo = note.inReplyTo;
    }

    response
      .status(200)
      .set("Content-Type", "application/activity+json; charset=utf-8")
      .set("Cache-Control", "public, max-age=3600")
      .json(noteJson);
  };
}
