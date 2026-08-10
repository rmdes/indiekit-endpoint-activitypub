/**
 * Facade for federation operations used by controllers.
 * Centralizes Fedify context creation and common patterns
 * so controllers don't access plugin._federation directly.
 * @module federation-actions
 */
import { lookupWithSecurity } from "./lookup-helpers.js";

/**
 * Create a Fedify context from the plugin reference.
 * @param {object} plugin - ActivityPubEndpoint instance
 * @returns {object} Fedify Context
 */
export function createContext(plugin) {
  const handle = plugin.options.actor.handle;
  return plugin._federation.createContext(new URL(plugin._publicationUrl), {
    handle,
    publicationUrl: plugin._publicationUrl,
  });
}

/**
 * Get an authenticated document loader for signed HTTP fetches.
 * @param {object} plugin - ActivityPubEndpoint instance
 * @returns {Promise<object>} Fedify DocumentLoader
 */
export async function getAuthLoader(plugin) {
  const ctx = createContext(plugin);
  return ctx.getDocumentLoader({ identifier: plugin.options.actor.handle });
}

/**
 * Resolve a remote actor with signed→unsigned fallback.
 * @param {object} plugin - ActivityPubEndpoint instance
 * @param {string|URL} target - Actor URL or acct: URI
 * @param {object} [options] - Additional options for lookupWithSecurity
 * @returns {Promise<object|null>} Resolved actor or null
 */
export async function resolveActor(plugin, target, options = {}) {
  const ctx = createContext(plugin);
  const documentLoader = await ctx.getDocumentLoader({
    identifier: plugin.options.actor.handle,
  });
  const url = target instanceof URL ? target : new URL(target);
  return lookupWithSecurity(ctx, url, { documentLoader, ...options });
}

/**
 * Check if federation is initialized and ready.
 * @param {object} plugin - ActivityPubEndpoint instance
 * @returns {boolean}
 */
export function isFederationReady(plugin) {
  return !!plugin._federation;
}

/** @returns {string} Our actor handle */
export function getHandle(plugin) {
  return plugin.options.actor.handle;
}

/** @returns {string} Our publication URL */
export function getPublicationUrl(plugin) {
  return plugin._publicationUrl;
}

/** @returns {object} MongoDB collections */
export function getCollections(plugin) {
  return plugin._collections;
}

/**
 * Get the Fedify Federation instance.
 *
 * Needed by the shared interaction helpers, which create their own context
 * from `federation` rather than receiving one. Exposed here so controllers
 * still never touch `plugin._federation` directly.
 *
 * @param {object} plugin - ActivityPubEndpoint instance
 * @returns {object} Fedify Federation
 */
export function getFederation(plugin) {
  return plugin._federation;
}
