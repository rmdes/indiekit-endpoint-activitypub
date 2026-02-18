/**
 * Build an ActivityPub Person actor document.
 *
 * This is the identity document that remote servers fetch to learn about
 * this actor — it contains the profile, endpoints, and the public key
 * used to verify HTTP Signatures on outbound activities.
 *
 * @param {object} options
 * @param {string} options.actorUrl - Actor URL (also the Person id)
 * @param {string} options.publicationUrl - Publication base URL (trailing slash)
 * @param {string} options.mountPath - Plugin mount path (e.g. "/activitypub")
 * @param {string} options.handle - Preferred username (e.g. "rick")
 * @param {string} options.name - Display name
 * @param {string} options.summary - Bio / profile summary
 * @param {string} options.icon - Avatar URL or path
 * @param {string} options.alsoKnownAs - Previous account URL (for Mastodon migration)
 * @param {string} options.publicKeyPem - PEM-encoded RSA public key
 * @returns {object} ActivityStreams Person document
 */
export function buildActorDocument(options) {
  const {
    actorUrl,
    publicationUrl,
    mountPath,
    handle,
    name,
    summary,
    icon,
    alsoKnownAs,
    publicKeyPem,
  } = options;

  const baseUrl = publicationUrl.replace(/\/$/, "");

  const actor = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    type: "Person",
    id: actorUrl,
    preferredUsername: handle,
    name: name || handle,
    url: actorUrl,
    inbox: `${baseUrl}${mountPath}/inbox`,
    outbox: `${baseUrl}${mountPath}/outbox`,
    followers: `${baseUrl}${mountPath}/followers`,
    following: `${baseUrl}${mountPath}/following`,
    publicKey: {
      id: `${actorUrl}#main-key`,
      owner: actorUrl,
      publicKeyPem,
    },
  };

  if (summary) {
    actor.summary = summary;
  }

  if (icon) {
    const iconUrl = icon.startsWith("http") ? icon : `${baseUrl}${icon.startsWith("/") ? "" : "/"}${icon}`;
    actor.icon = {
      type: "Image",
      url: iconUrl,
    };
  }

  if (alsoKnownAs) {
    actor.alsoKnownAs = Array.isArray(alsoKnownAs)
      ? alsoKnownAs
      : [alsoKnownAs];
  }

  return actor;
}
