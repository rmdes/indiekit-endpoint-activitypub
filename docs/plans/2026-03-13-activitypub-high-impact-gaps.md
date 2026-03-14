# ActivityPub High-Impact Gaps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all high-impact ActivityPub coverage gaps identified in the coverage audit, bringing federation compliance from ~70% to ~85%.

**Architecture:** Five independent features, each following existing codebase patterns. Outbound Delete uses the `broadcastActorUpdate()` batch delivery pattern. Visibility addressing extends `jf2ToAS2Activity()`. Content warnings add `sensitive`/`summary` to outbound objects. Inbound polls parse Fedify `Question` objects. Inbound reports add a `Flag` inbox listener with a new collection.

**Tech Stack:** Fedify 2.0 (`@fedify/fedify/vocab`), Express 5, MongoDB, Nunjucks, Alpine.js

**Audit Correction:** The audit listed "Outbound Block" as not implemented. During plan research, `lib/controllers/moderation.js:148-182` was found to already send `Block` via `ctx.sendActivity()` on block and `Undo(Block)` on unblock. **Block is fully implemented — no work needed.**

---

## Task 1: Outbound Delete Activity

When a post is deleted from Indiekit, remote servers currently keep showing it forever. This task adds a `broadcastDelete(postUrl)` method and an admin API route to send `Delete` activities to all followers.

**Files:**
- Modify: `index.js` (add method + route + import)
- No new files needed

### Step 1: Add `broadcastDelete()` method to `index.js`

Add this method after `broadcastActorUpdate()` (after line ~870). It follows the exact same pattern: create context, build activity, fetch followers, deduplicate by shared inbox, batch deliver.

```javascript
/**
 * Send Delete activity to all followers for a removed post.
 * Mirrors broadcastActorUpdate() pattern: batch delivery with shared inbox dedup.
 * @param {string} postUrl - Full URL of the deleted post
 */
async broadcastDelete(postUrl) {
  if (!this._federation) return;

  try {
    const { Delete } = await import("@fedify/fedify/vocab");
    const handle = this.options.actor.handle;
    const ctx = this._federation.createContext(
      new URL(this._publicationUrl),
      { handle, publicationUrl: this._publicationUrl },
    );

    const del = new Delete({
      actor: ctx.getActorUri(handle),
      object: new URL(postUrl),
    });

    const followers = await this._collections.ap_followers
      .find({})
      .project({ actorUrl: 1, inbox: 1, sharedInbox: 1 })
      .toArray();

    const inboxMap = new Map();
    for (const f of followers) {
      const key = f.sharedInbox || f.inbox;
      if (key && !inboxMap.has(key)) {
        inboxMap.set(key, f);
      }
    }

    const uniqueRecipients = [...inboxMap.values()];
    const BATCH_SIZE = 25;
    const BATCH_DELAY_MS = 5000;
    let delivered = 0;
    let failed = 0;

    console.info(
      `[ActivityPub] Broadcasting Delete for ${postUrl} to ${uniqueRecipients.length} ` +
        `unique inboxes (${followers.length} followers)`,
    );

    for (let i = 0; i < uniqueRecipients.length; i += BATCH_SIZE) {
      const batch = uniqueRecipients.slice(i, i + BATCH_SIZE);
      const recipients = batch.map((f) => ({
        id: new URL(f.actorUrl),
        inboxId: new URL(f.inbox || f.sharedInbox),
        endpoints: f.sharedInbox
          ? { sharedInbox: new URL(f.sharedInbox) }
          : undefined,
      }));

      try {
        await ctx.sendActivity(
          { identifier: handle },
          recipients,
          del,
          { preferSharedInbox: true },
        );
        delivered += batch.length;
      } catch (error) {
        failed += batch.length;
        console.warn(
          `[ActivityPub] Delete batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`,
        );
      }

      if (i + BATCH_SIZE < uniqueRecipients.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    console.info(
      `[ActivityPub] Delete broadcast complete for ${postUrl}: ${delivered} delivered, ${failed} failed`,
    );

    await logActivity(this._collections.ap_activities, {
      direction: "outbound",
      type: "Delete",
      actorUrl: this._publicationUrl,
      objectUrl: postUrl,
      summary: `Sent Delete for ${postUrl} to ${delivered} inboxes`,
    });
  } catch (error) {
    console.warn("[ActivityPub] broadcastDelete failed:", error.message);
  }
}
```

### Step 2: Add admin API route for federation delete

In the `get routes()` getter (after line ~311), add:

```javascript
router.post("/admin/federation/delete", deleteFederationController(mp, this));
```

### Step 3: Create the controller function

Add a new export in `lib/controllers/messages.js` — or better, create it inline in `index.js` near the route registration. The simplest approach: add the controller as a local function before the class, or add it to an existing controller file.

Create a minimal controller. Add this import at the top of `index.js` alongside other controller imports:

```javascript
import { deleteFederationController } from "./lib/controllers/federation-delete.js";
```

Create `lib/controllers/federation-delete.js`:

```javascript
/**
 * POST /admin/federation/delete — Send Delete activity to all followers.
 * Removes a post from the fediverse after local deletion.
 * @param {string} mountPath - Plugin mount path
 * @param {object} plugin - ActivityPub plugin instance
 */
import { validateToken } from "../csrf.js";

export function deleteFederationController(mountPath, plugin) {
  return async (request, response, next) => {
    try {
      if (!validateToken(request)) {
        return response.status(403).json({
          success: false,
          error: "Invalid CSRF token",
        });
      }

      const { url } = request.body;
      if (!url) {
        return response.status(400).json({
          success: false,
          error: "Missing post URL",
        });
      }

      await plugin.broadcastDelete(url);

      if (request.headers.accept?.includes("application/json")) {
        return response.json({ success: true, url });
      }

      const referrer = request.get("Referrer") || `${mountPath}/admin/activities`;
      return response.redirect(referrer);
    } catch (error) {
      next(error);
    }
  };
}
```

### Step 4: Add i18n string

In `locales/en.json`, add under a new `"federation"` key:

```json
"federation": {
  "deleteSuccess": "Delete activity sent to followers",
  "deleteButton": "Delete from fediverse"
}
```

### Step 5: Verify syntax

Run: `node -c index.js && node -c lib/controllers/federation-delete.js`
Expected: No errors

### Step 6: Commit

```bash
git add index.js lib/controllers/federation-delete.js locales/en.json
git commit -m "feat: outbound Delete activity — broadcast to followers when posts are removed"
```

---

## Task 2: Visibility Addressing (Unlisted + Followers-Only)

Currently all syndicated posts use public addressing (`to: PUBLIC, cc: followers`). This task adds support for unlisted and followers-only visibility via a `defaultVisibility` config option and per-post `visibility` property.

**Files:**
- Modify: `lib/jf2-to-as2.js:151-267` (addressing logic)
- Modify: `index.js:423-505` (pass visibility to converter, add config option)

### Step 1: Update `jf2ToAS2Activity()` addressing

In `lib/jf2-to-as2.js`, modify the function signature and addressing block (lines 151, 179-194).

**Change function signature** (line 151):

```javascript
export function jf2ToAS2Activity(properties, actorUrl, publicationUrl, options = {}) {
```

No change needed — `options` already exists. We'll pass `visibility` through it.

**Replace lines 179-194** (the addressing block) with:

```javascript
  const noteOptions = {
    attributedTo: actorUri,
  };

  // Determine visibility: per-post override > option default > "public"
  const visibility = properties.visibility || options.visibility || "public";

  // Addressing based on visibility
  // - "public":        to: PUBLIC, cc: followers (+ reply author)
  // - "unlisted":      to: followers, cc: PUBLIC (+ reply author)
  // - "followers":     to: followers (+ reply author), no PUBLIC
  // - "direct":        handled separately (DMs)
  const PUBLIC = new URL("https://www.w3.org/ns/activitystreams#Public");
  const followersUri = new URL(followersUrl);

  if (replyToActorUrl && properties["in-reply-to"]) {
    const replyAuthor = new URL(replyToActorUrl);
    if (visibility === "unlisted") {
      noteOptions.to = followersUri;
      noteOptions.ccs = [PUBLIC, replyAuthor];
    } else if (visibility === "followers") {
      noteOptions.tos = [followersUri, replyAuthor];
    } else {
      // public (default)
      noteOptions.to = PUBLIC;
      noteOptions.ccs = [followersUri, replyAuthor];
    }
  } else {
    if (visibility === "unlisted") {
      noteOptions.to = followersUri;
      noteOptions.cc = PUBLIC;
    } else if (visibility === "followers") {
      noteOptions.to = followersUri;
    } else {
      // public (default)
      noteOptions.to = PUBLIC;
      noteOptions.cc = followersUri;
    }
  }
```

Also update the plain JSON-LD function `jf2ToActivityStreams()` (lines 81-82) with the same pattern. Replace:

```javascript
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${actorUrl.replace(/\/$/, "")}/followers`],
```

With:

```javascript
    to: visibility === "unlisted"
      ? [`${actorUrl.replace(/\/$/, "")}/followers`]
      : visibility === "followers"
        ? [`${actorUrl.replace(/\/$/, "")}/followers`]
        : ["https://www.w3.org/ns/activitystreams#Public"],
    cc: visibility === "unlisted"
      ? ["https://www.w3.org/ns/activitystreams#Public"]
      : visibility === "followers"
        ? []
        : [`${actorUrl.replace(/\/$/, "")}/followers`],
```

Note: `jf2ToActivityStreams` needs `visibility` passed in. Add a fourth parameter:

```javascript
export function jf2ToActivityStreams(properties, actorUrl, publicationUrl, options = {}) {
  const visibility = properties.visibility || options.visibility || "public";
```

### Step 2: Add `defaultVisibility` config option

In `index.js`, add to the defaults object (near the top, in constructor defaults):

```javascript
defaultVisibility: "public", // "public" | "unlisted" | "followers"
```

### Step 3: Pass visibility in syndicator

In `index.js` syndicator `syndicate()` method (around line 466), where `jf2ToAS2Activity()` is called, pass the visibility option:

```javascript
const activity = jf2ToAS2Activity(properties, actorUrl, self._publicationUrl, {
  replyToActorUrl: originalAuthorUrl,
  replyToActorHandle: originalAuthorHandle,
  visibility: properties.visibility || self.options.defaultVisibility,
});
```

### Step 4: Verify syntax

Run: `node -c lib/jf2-to-as2.js && node -c index.js`
Expected: No errors

### Step 5: Commit

```bash
git add lib/jf2-to-as2.js index.js
git commit -m "feat: unlisted + followers-only visibility addressing"
```

---

## Task 3: Content Warning / Sensitive Flag (Outbound)

Inbound sensitive content is already parsed (`timeline-store.js:152-153`) and rendered with a toggle (`ap-item-card.njk:79-87`). This task adds `sensitive` and `summary` (CW text) to outbound activities.

**Files:**
- Modify: `lib/jf2-to-as2.js:207-230` (add sensitive/summary to Note/Article options)

### Step 1: Add sensitive + summary to Fedify objects

In `lib/jf2-to-as2.js`, after the published date block (after line 207) and before the content block (line 209), add:

```javascript
  // Content warning / sensitive flag
  if (properties.sensitive) {
    noteOptions.sensitive = true;
  }
  if (properties["post-status"] === "sensitive") {
    noteOptions.sensitive = true;
  }
  // Summary doubles as CW text in Mastodon
  if (properties.summary && !isArticle) {
    noteOptions.summary = properties.summary;
    noteOptions.sensitive = true;
  }
```

Note: For articles, summary is already handled at line 228-231. The `sensitive` flag should still be set:

After line 231, add:

```javascript
  if (properties.sensitive && isArticle) {
    noteOptions.sensitive = true;
  }
```

Also add to the plain JSON-LD function `jf2ToActivityStreams()` — after line 112, add:

```javascript
  if (properties.sensitive || properties["post-status"] === "sensitive") {
    object.sensitive = true;
  }
```

### Step 2: Verify syntax

Run: `node -c lib/jf2-to-as2.js`
Expected: No errors

### Step 3: Commit

```bash
git add lib/jf2-to-as2.js
git commit -m "feat: outbound content warning / sensitive flag support"
```

---

## Task 4: Question / Poll Support (Inbound)

Poll posts from Mastodon currently render without options because `extractObjectData()` doesn't handle `Question` objects. This task adds poll parsing and a template partial for rendering poll options.

**Files:**
- Modify: `lib/timeline-store.js:122-137` (add Question type detection + option extraction)
- Create: `views/partials/ap-poll-options.njk` (poll rendering partial)
- Modify: `views/partials/ap-item-card.njk` (include poll partial)
- Modify: `locales/en.json` (add poll i18n strings)

### Step 1: Add Question import to timeline-store.js

At the top of `lib/timeline-store.js`, find the import from `@fedify/fedify/vocab` and add `Question`:

```javascript
import { Article, Question } from "@fedify/fedify/vocab";
```

If `Article` is already imported individually, just add `Question` to the same import.

### Step 2: Add Question type detection in `extractObjectData()`

In `lib/timeline-store.js`, after the type detection block (lines 130-137), extend it:

```javascript
  // Determine type — use instanceof for Fedify vocab objects
  let type = "note";
  if (object instanceof Article) {
    type = "article";
  }
  if (object instanceof Question) {
    type = "question";
  }
  if (options.boostedBy) {
    type = "boost";
  }
```

### Step 3: Extract poll options

After the `sensitive` extraction (line 153), add poll option extraction:

```javascript
  // Poll options (Question type)
  let pollOptions = [];
  let votersCount = 0;
  let pollClosed = false;
  let pollEndTime = "";

  if (object instanceof Question) {
    // Fedify reads both oneOf (single-choice) and anyOf (multi-choice)
    try {
      const exclusive = [];
      for await (const opt of object.getExclusiveOptions?.() || []) {
        exclusive.push({
          name: opt.name?.toString() || "",
          votes: typeof opt.replies?.totalItems === "number" ? opt.replies.totalItems : 0,
        });
      }
      const inclusive = [];
      for await (const opt of object.getInclusiveOptions?.() || []) {
        inclusive.push({
          name: opt.name?.toString() || "",
          votes: typeof opt.replies?.totalItems === "number" ? opt.replies.totalItems : 0,
        });
      }
      pollOptions = exclusive.length > 0 ? exclusive : inclusive;
    } catch {
      // Poll options couldn't be extracted — show as regular post
    }

    votersCount = typeof object.votersCount === "number" ? object.votersCount : 0;
    pollEndTime = object.endTime ? String(object.endTime) : "";
    pollClosed = object.closed != null;
  }
```

### Step 4: Include poll data in returned object

In the return object of `extractObjectData()` (around lines 304-325), add the poll fields:

```javascript
    pollOptions,
    votersCount,
    pollClosed,
    pollEndTime,
```

### Step 5: Create poll rendering partial

Create `views/partials/ap-poll-options.njk`:

```nunjucks
{# Poll options partial — renders vote results for Question-type posts #}
{% if item.pollOptions and item.pollOptions.length > 0 %}
  {% set totalVotes = 0 %}
  {% for opt in item.pollOptions %}
    {% set totalVotes = totalVotes + opt.votes %}
  {% endfor %}

  <div class="ap-poll">
    {% for opt in item.pollOptions %}
      {% set pct = (totalVotes > 0) and ((opt.votes / totalVotes * 100) | round) or 0 %}
      <div class="ap-poll__option">
        <div class="ap-poll__bar" style="width: {{ pct }}%"></div>
        <span class="ap-poll__label">{{ opt.name }}</span>
        <span class="ap-poll__votes">{{ pct }}%</span>
      </div>
    {% endfor %}
    <div class="ap-poll__footer">
      {% if item.votersCount > 0 %}
        {{ item.votersCount }} {{ __("activitypub.poll.voters") }}
      {% elif totalVotes > 0 %}
        {{ totalVotes }} {{ __("activitypub.poll.votes") }}
      {% endif %}
      {% if item.pollClosed %}
        · {{ __("activitypub.poll.closed") }}
      {% elif item.pollEndTime %}
        · {{ __("activitypub.poll.endsAt") }} <time datetime="{{ item.pollEndTime }}">{{ item.pollEndTime | date("PPp") }}</time>
      {% endif %}
    </div>
  </div>
{% endif %}
```

### Step 6: Include partial in item card

In `views/partials/ap-item-card.njk`, after the content block (after the `</div>` that closes `.ap-item__content`) and before attachments/link preview, add:

```nunjucks
    {# Poll options #}
    {% if item.type == "question" or (item.pollOptions and item.pollOptions.length > 0) %}
      {% include "partials/ap-poll-options.njk" %}
    {% endif %}
```

### Step 7: Add CSS for poll rendering

In `assets/reader.css`, add a new section:

```css
/* ==========================================================================
   Poll / Question
   ========================================================================== */

.ap-poll {
  margin-top: var(--space-s);
}

.ap-poll__option {
  position: relative;
  padding: var(--space-xs) var(--space-s);
  margin-bottom: var(--space-xs);
  border-radius: var(--border-radius-small);
  background: var(--color-offset);
  overflow: hidden;
}

.ap-poll__bar {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: var(--color-primary);
  opacity: 0.15;
  border-radius: var(--border-radius-small);
}

.ap-poll__label {
  position: relative;
  font-size: var(--font-size-s);
  color: var(--color-on-background);
}

.ap-poll__votes {
  position: relative;
  float: right;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--color-on-offset);
}

.ap-poll__footer {
  font-size: var(--font-size-xs);
  color: var(--color-on-offset);
  margin-top: var(--space-xs);
}
```

### Step 8: Add i18n strings

In `locales/en.json`, add:

```json
"poll": {
  "voters": "voters",
  "votes": "votes",
  "closed": "Poll closed",
  "endsAt": "Ends"
}
```

### Step 9: Verify syntax

Run: `node -c lib/timeline-store.js`
Expected: No errors

### Step 10: Commit

```bash
git add lib/timeline-store.js views/partials/ap-poll-options.njk views/partials/ap-item-card.njk assets/reader.css locales/en.json
git commit -m "feat: inbound poll/question support — parse and render vote options"
```

---

## Task 5: Flag Handler (Inbound Reports)

Other fediverse servers can send `Flag` activities to report abusive content or actors. Currently these are silently dropped. This task adds a `Flag` inbox listener, an `ap_reports` collection, admin notification, and a reports view in the moderation dashboard.

**Files:**
- Modify: `lib/inbox-listeners.js` (add Flag handler)
- Modify: `index.js` (register ap_reports collection + indexes)
- Modify: `lib/storage/notifications.js:129` (add "report" to type counts)
- Modify: `views/partials/ap-notification-card.njk` (add report notification type)
- Modify: `views/activitypub-notifications.njk` (add Reports tab)
- Modify: `lib/controllers/reader.js` (add "report" to validTabs)
- Modify: `locales/en.json` (add report i18n strings)

### Step 1: Register `ap_reports` collection in `index.js`

In the collection registration block (around line 891), add:

```javascript
Indiekit.addCollection("ap_reports");
```

In the collection storage block (around line 910), add:

```javascript
ap_reports: indiekitCollections.get("ap_reports"),
```

In the indexes block (around line 1000), add:

```javascript
// ap_reports indexes
try {
  await this._collections.ap_reports.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: notifRetention || undefined },
  );
  await this._collections.ap_reports.createIndex({ reporterUrl: 1 });
  await this._collections.ap_reports.createIndex({ reportedUrl: 1 });
} catch {
  // Indexes may already exist
}
```

### Step 2: Add Flag inbox listener

In `lib/inbox-listeners.js`, add the `Flag` import to the destructure from `@fedify/fedify/vocab` (around line 6-24). Then add a new handler after the Block handler (after line ~744):

```javascript
  // ── Flag (Report) ──────────────────────────────────────────────
  .on(Flag, async (ctx, flag) => {
    try {
      const authLoader = getAuthLoader ? await getAuthLoader(ctx) : undefined;
      const actorObj = await flag.getActor({ documentLoader: authLoader }).catch(() => null);

      const reporterUrl = actorObj?.id?.href || flag.actorId?.href || "";
      const reporterName = actorObj?.name?.toString() || actorObj?.preferredUsername?.toString() || reporterUrl;

      // Extract reported objects — Flag can report actors or posts
      const reportedIds = flag.objectIds?.map((u) => u.href) || [];
      const reason = flag.content?.toString() || "";

      if (reportedIds.length === 0 && !reason) {
        console.info("[ActivityPub] Ignoring empty Flag from", reporterUrl);
        return;
      }

      // Store report
      if (collections.ap_reports) {
        await collections.ap_reports.insertOne({
          reporterUrl,
          reporterName,
          reportedUrls: reportedIds,
          reason,
          createdAt: new Date().toISOString(),
          read: false,
        });
      }

      // Create notification
      if (collections.ap_notifications) {
        const { addNotification } = await import("./storage/notifications.js");
        await addNotification(collections, {
          uid: `flag:${reporterUrl}:${Date.now()}`,
          type: "report",
          actorUrl: reporterUrl,
          actorName: reporterName,
          actorPhoto: actorObj?.iconUrl?.href || actorObj?.icon?.url?.href || "",
          actorHandle: actorObj?.preferredUsername
            ? `@${actorObj.preferredUsername}@${new URL(reporterUrl).hostname}`
            : reporterUrl,
          objectUrl: reportedIds[0] || "",
          summary: reason ? reason.slice(0, 200) : "Report received",
          published: new Date().toISOString(),
        });
      }

      await logActivity(collections, {
        direction: "inbound",
        type: "Flag",
        actorUrl: reporterUrl,
        objectUrl: reportedIds[0] || "",
        summary: `Report from ${reporterName}: ${reason.slice(0, 100)}`,
      });

      console.info(`[ActivityPub] Flag received from ${reporterName} — ${reportedIds.length} objects reported`);
    } catch (error) {
      console.warn("[ActivityPub] Flag handler error:", error.message);
    }
  })
```

### Step 3: Update notification type handling

In `lib/storage/notifications.js`, in `getNotificationCountsByType()` (around line 129), add `report: 0` to the counts object:

```javascript
const counts = { all: 0, reply: 0, like: 0, boost: 0, follow: 0, dm: 0, report: 0 };
```

And add the case to handle `_id === "report"`.

### Step 4: Update notification card template

In `views/partials/ap-notification-card.njk`, add the report type badge and action text:

Type badge (alongside other `elif` checks):
```nunjucks
{% elif item.type == "report" %}⚑
```

Action text:
```nunjucks
{% elif item.type == "report" %}{{ __("activitypub.reports.sentReport") }}
```

### Step 5: Add Reports tab to notifications

In `views/activitypub-notifications.njk`, add a Reports tab alongside the DMs tab:

```nunjucks
<a href="?tab=report"
   class="ap-tab{% if activeTab == 'report' %} ap-tab--active{% endif %}">
  {{ __("activitypub.notifications.tabs.reports") }}
  {% if counts.report > 0 %}
    <span class="ap-tab__count">{{ counts.report }}</span>
  {% endif %}
</a>
```

### Step 6: Add "report" to valid tabs

In `lib/controllers/reader.js`, add `"report"` to the `validTabs` array:

```javascript
const validTabs = ["all", "reply", "like", "boost", "follow", "dm", "report"];
```

### Step 7: Add i18n strings

In `locales/en.json`, add:

```json
"reports": {
  "sentReport": "filed a report",
  "title": "Reports"
}
```

And add to `notifications.tabs`:

```json
"reports": "Reports"
```

### Step 8: Verify syntax

Run: `node -c lib/inbox-listeners.js && node -c lib/storage/notifications.js && node -c index.js`
Expected: No errors

### Step 9: Commit

```bash
git add lib/inbox-listeners.js lib/storage/notifications.js views/partials/ap-notification-card.njk views/activitypub-notifications.njk lib/controllers/reader.js locales/en.json index.js
git commit -m "feat: inbound Flag handler — receive and display abuse reports"
```

---

## Verification Plan

After all tasks are implemented:

1. **Outbound Delete** — Create a test post, syndicate to fediverse. Delete from Indiekit. Call `POST /activitypub/admin/federation/delete` with the post URL. Check activity log shows outbound Delete. Verify from a Mastodon account that the post is removed.

2. **Visibility** — Set `defaultVisibility: "unlisted"` in config. Create a post. Check from Mastodon that the post appears in the home timeline of followers but NOT on the public/federated timeline. Reset to "public".

3. **Content Warning** — Create a post with `sensitive: true` and a `summary` field via Micropub. Verify from Mastodon that the post shows behind a CW toggle with the summary text.

4. **Polls** — From Mastodon, create a poll and post it. View the reader timeline. Verify poll options render with percentage bars and voter count.

5. **Reports** — From a Mastodon instance, report the test actor. Check that:
   - A notification appears in the Reports tab
   - The activity log shows an inbound Flag
   - The `ap_reports` collection has the report entry

---

## Summary

| Task | Gap Closed | Priority | Files Changed |
|------|-----------|----------|---------------|
| 1 | Outbound Delete | P1 — High | index.js, new controller, en.json |
| 2 | Unlisted + Followers-only | P1/P2 | jf2-to-as2.js, index.js |
| 3 | Content Warning (outbound) | P2 | jf2-to-as2.js |
| 4 | Question/Poll (inbound) | P2 | timeline-store.js, new partial, item-card, CSS, en.json |
| 5 | Flag Handler (inbound) | P2 | inbox-listeners.js, notifications.js, templates, en.json, index.js |
| — | Block (outbound) | **Already implemented** | No work needed |

**Estimated coverage after implementation:** ~85% of Fedify capabilities, ~98% of real-world fediverse traffic.
