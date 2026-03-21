/**
 * Relationship entity serializer for Mastodon Client API.
 *
 * Represents the relationship between the authenticated user
 * and another account.
 */

/**
 * Serialize a Relationship entity.
 *
 * @param {string} id - Account ID
 * @param {object} state - Relationship state
 * @param {boolean} [state.following=false]
 * @param {boolean} [state.followed_by=false]
 * @param {boolean} [state.blocking=false]
 * @param {boolean} [state.muting=false]
 * @param {boolean} [state.requested=false]
 * @returns {object} Mastodon Relationship entity
 */
export function serializeRelationship(id, state = {}) {
  return {
    id,
    following: state.following || false,
    showing_reblogs: state.following || false,
    notifying: false,
    languages: [],
    followed_by: state.followed_by || false,
    blocking: state.blocking || false,
    blocked_by: false,
    muting: state.muting || false,
    muting_notifications: state.muting || false,
    requested: state.requested || false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: "",
  };
}
