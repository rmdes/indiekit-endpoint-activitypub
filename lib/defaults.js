/**
 * Default plugin options for @rmdes/indiekit-endpoint-activitypub.
 * Merged over user options in the endpoint constructor.
 */
export const DEFAULTS = {
  mountPath: "/activitypub",
  actor: {
    handle: "rick",
    name: "",
    summary: "",
    icon: "",
  },
  checked: true,
  alsoKnownAs: "",
  activityRetentionDays: 90,
  storeRawActivities: false,
  redisUrl: "",
  parallelWorkers: 5,
  actorType: "Person",
  logLevel: "warning",
  timelineRetention: 1000,
  notificationRetentionDays: 30,
  debugDashboard: false,
  debugPassword: "",
  defaultVisibility: "public", // "public" | "unlisted" | "followers"
};

/**
 * Merge user options over defaults (deep-merges the nested `actor` object).
 * @param {object} [options]
 * @returns {object} resolved options
 */
export function resolveOptions(options = {}) {
  const merged = { ...DEFAULTS, ...options };
  merged.actor = { ...DEFAULTS.actor, ...options.actor };
  return merged;
}
