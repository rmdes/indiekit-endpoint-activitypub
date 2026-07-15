/**
 * Backfill deliverable addresses for followers stored with no inbox.
 *
 * inbox-listeners.js previously read the follower inbox via the wrong Fedify
 * accessor (`actor.inbox?.id?.href` instead of `actor.inboxId?.href`), so every
 * inbound Follow landed with `inbox: ""`. Followers whose server ALSO lacks a
 * sharedInbox therefore have NO deliverable address and silently miss every
 * broadcast (Create/Update/Delete).
 *
 * This re-resolves only that both-empty set (tiny — the ~305 empty-inbox but
 * sharedInbox-having followers still deliver via the shared inbox, so we leave
 * them alone) and populates inbox/sharedInbox from the live actor. Idempotent:
 * once a follower has any deliverable address it no longer matches, so repeat
 * runs are no-ops. Unresolvable actors are left for a future run.
 *
 * @module migrations/backfill-follower-inbox
 */
import { lookupWithSecurity } from "../lookup-helpers.js";

const EMPTY = (field) => ({
  $or: [{ [field]: "" }, { [field]: { $exists: false } }, { [field]: null }],
});

/**
 * @param {object} deps
 * @param {object} deps.federation - Fedify Federation instance
 * @param {object} deps.collections - MongoDB collections
 * @param {string} deps.handle - local actor handle (for signed lookups)
 * @param {string} deps.publicationUrl - local publication URL
 * @returns {Promise<{skipped: boolean, attempted?: number, updated?: number}>}
 */
export async function backfillFollowerInbox({
  federation,
  collections,
  handle,
  publicationUrl,
}) {
  if (!federation || !collections?.ap_followers || !publicationUrl) {
    return { skipped: true };
  }

  const broken = await collections.ap_followers
    .find({ $and: [EMPTY("inbox"), EMPTY("sharedInbox")] })
    .project({ actorUrl: 1 })
    .toArray();

  if (broken.length === 0) return { skipped: false, updated: 0 };

  const ctx = federation.createContext(new URL(publicationUrl), {
    handle,
    publicationUrl,
  });

  // Authenticated loader so Authorized-Fetch servers resolve (see gotcha #4).
  let documentLoader;
  try {
    documentLoader = await ctx.getDocumentLoader({ identifier: handle });
  } catch {
    documentLoader = undefined;
  }

  let updated = 0;
  for (const f of broken) {
    if (!f.actorUrl) continue;
    try {
      const actor = await lookupWithSecurity(
        ctx,
        f.actorUrl,
        documentLoader ? { documentLoader } : {},
      );
      const inbox = actor?.inboxId?.href || "";
      const sharedInbox = actor?.endpoints?.sharedInbox?.href || "";
      if (inbox || sharedInbox) {
        await collections.ap_followers.updateOne(
          { actorUrl: f.actorUrl },
          { $set: { inbox, sharedInbox } },
        );
        updated++;
      }
    } catch {
      // unresolvable right now — leave for a future run
    }
  }

  return { skipped: false, attempted: broken.length, updated };
}
