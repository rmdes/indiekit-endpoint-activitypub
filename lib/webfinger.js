/**
 * Handle WebFinger resource resolution.
 *
 * WebFinger is the discovery mechanism for ActivityPub — when someone
 * searches for @rick@rmendes.net, their server queries:
 *   GET /.well-known/webfinger?resource=acct:rick@rmendes.net
 *
 * We return a JRD (JSON Resource Descriptor) pointing to the actor URL
 * so the remote server can then fetch the full actor document.
 *
 * @param {string} resource - The resource query (e.g. "acct:rick@rmendes.net")
 * @param {object} options
 * @param {string} options.handle - Actor handle (e.g. "rick")
 * @param {string} options.hostname - Publication hostname (e.g. "rmendes.net")
 * @param {string} options.actorUrl - Full actor URL (e.g. "https://rmendes.net/")
 * @returns {object|null} JRD response object, or null if resource doesn't match
 */
export function handleWebFinger(resource, options) {
  const { handle, hostname, actorUrl } = options;
  const expectedAcct = `acct:${handle}@${hostname}`;

  // Match both "acct:rick@rmendes.net" and the actor URL itself
  if (resource !== expectedAcct && resource !== actorUrl) {
    return null;
  }

  return {
    subject: expectedAcct,
    aliases: [actorUrl],
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: actorUrl,
      },
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: actorUrl,
      },
    ],
  };
}
