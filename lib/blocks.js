/**
 * ActivityPub v2 block declaration (Phase 7b — plugin block ownership).
 *
 * The `fediverse-follow` sidebar widget was a site-config BUILTIN_BLOCKS seed
 * (requiresPlugin null, gated only by the theme's legacy widgetPluginRequirements
 * render-map). Declaring it here makes site-config's scanPlugins stamp
 * `sourcePlugin` → `requiresPlugin` ("ActivityPub endpoint"), so the block is
 * properly plugin-gated (theme ENDPOINT_SLUGS maps it to the `activitypub`
 * loadout slug). scanPlugins precedence is `built-in < plugin blocks`, so this
 * entry OVERWRITES the builtin seed on sites where the plugin is loaded; the seed
 * itself is removed from site-config in Phase 7d alongside the legacy-map bridge.
 *
 * activitypub is `default_enabled: false` — on a site without it loaded (e.g.
 * chardonsbleus) the block correctly never appears in that site's catalog once
 * the builtin seed is removed in 7d. Descriptor is byte-faithful to the
 * BUILTIN_BLOCKS entry. Bespoke template: the theme owns
 * `components/widgets/fediverse-follow.njk` (no generic `render.renderer`);
 * `data.source:"config"` documents that it renders from config, not a runtime feed.
 *
 * @module lib/blocks
 */

/** @type {Array<object>} */
export const ACTIVITYPUB_BLOCKS = [
  {
    id: "fediverse-follow",
    version: 1,
    label: "Fediverse Follow",
    description: "Follow button for fediverse instances",
    icon: "globe",
    category: "social",
    placement: { regions: ["sidebar"], surfaces: ["homepage"] },
    multiple: false,
    data: { source: "config" },
    schema: { type: "object", additionalProperties: false, properties: {} },
  },
];
