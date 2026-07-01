/**
 * Admin navigation items for the ActivityPub endpoint.
 * Extracted from index.js so the nav structure is unit-testable.
 */

/**
 * Build the plugin's admin navigation items.
 * @param {string} mountPath - The plugin mount path (e.g. "/activitypub")
 * @returns {Array<{href: string, text: string, requiresDatabase: boolean}>}
 */
export function buildNavigationItems(mountPath) {
  return [
    { href: mountPath, text: "activitypub.title", requiresDatabase: true },
    { href: `${mountPath}/admin/reader`, text: "activitypub.reader.title", requiresDatabase: true },
    { href: `${mountPath}/admin/reader/notifications`, text: "activitypub.notifications.title", requiresDatabase: true },
    { href: `${mountPath}/admin/reader/messages`, text: "activitypub.messages.title", requiresDatabase: true },
    { href: `${mountPath}/admin/reader/moderation`, text: "activitypub.moderation.title", requiresDatabase: true },
    { href: `${mountPath}/admin/my-profile`, text: "activitypub.myProfile.title", requiresDatabase: true },
    { href: `${mountPath}/admin/federation`, text: "activitypub.federationMgmt.title", requiresDatabase: true },
    { href: `${mountPath}/admin/settings`, text: "activitypub.settings.title", requiresDatabase: true },
  ];
}
