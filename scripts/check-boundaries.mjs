#!/usr/bin/env node
/**
 * Architecture boundary check (plan §Stage 5, rule 5.2).
 *
 * The single-lane refactor exists because two surfaces each grew their own
 * queries over one database and drifted into nine defects. The rule that stops
 * that happening again is simple:
 *
 *   ADAPTERS TRANSLATE. CORE DECIDES. ONLY CORE AND STORAGE TOUCH MONGO.
 *
 * Without an enforced boundary the next feature added under deadline goes
 * straight back into a controller, and the lanes re-form. This is the most
 * important task in the plan and the easiest to skip, so it runs in CI.
 *
 * HOW IT MATCHES — and why it changed (2026-09-13):
 * The first version matched receiver NAMES (`collections.x.find(`,
 * `collection.find(`). Any other variable walked straight past it — a
 * destructured `ap_timeline.findOne(`, a `followersCollection.countDocuments()`,
 * an optional-chained `pluginCollections.ap_blocked?.find(` — and it reported
 * "boundary holds" for a month while ~60 direct calls sat in 15 controllers.
 *
 * It now matches METHODS that only a MongoDB collection or cursor has, on any
 * receiver. Plain `.find(` is deliberately absent (Array.prototype.find is
 * everywhere); a Mongo find is still caught because its result has to be
 * materialised with `.toArray()`, which arrays do not have.
 *
 * Adapters also may not import lib/storage/* — the contract is
 * adapter → core → storage, so storage imports in an adapter are the same leak
 * one step removed.
 *
 * The allowlist below is DEBT, not policy. It must only ever shrink.
 *
 * Usage: node scripts/check-boundaries.mjs
 * Exit 0 clean, 1 on violation.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories whose modules are adapters: transport in, transport out. */
const ADAPTER_DIRS = [
  "lib/controllers",
  "lib/mastodon/routes",
  "lib/mastodon/helpers",
  "lib/mastodon/middleware",
  "lib/mastodon/entities",
  "lib/routes",
];

/**
 * Modules not yet ported to lib/core/*.
 *
 * This list existed as tracked debt during the Stage 2-4 port and went from 38
 * entries to zero — but only against the name-matching check, which could not
 * see most of what remained. The method-matching check (2026-09-13) re-found
 * these 20 modules / 64 hits. They are listed so each port lands as its own
 * green commit; every entry is removed as it is ported, and the list must end
 * EMPTY again. Adding an entry for new code is how this rule dies quietly: if a
 * new adapter needs data, give it a core function.
 */
const NOT_YET_PORTED = new Set([
  "lib/controllers/compose.js",
  "lib/controllers/dashboard.js",
  "lib/controllers/featured.js",
  "lib/controllers/federation-mgmt.js",
  "lib/controllers/follow-tag.js",
  "lib/controllers/followers.js",
  "lib/controllers/hashtag-explore.js",
  "lib/controllers/messages.js",
  "lib/controllers/migrate.js",
  "lib/controllers/moderation.js",
  "lib/controllers/my-profile.js",
  "lib/controllers/post-detail.js",
  "lib/controllers/profile.js",
  "lib/controllers/profile.remote.js",
  "lib/controllers/public-profile.js",
  "lib/controllers/reader.js",
  "lib/controllers/tag-timeline.js",
  "lib/mastodon/routes/search.js",
  "lib/mastodon/middleware/token-required.js",
  "lib/routes/public-routes.js",
]);

/** Methods that exist on a MongoDB Collection or Cursor and not on Array/Map. */
const MONGO_ONLY_METHODS = [
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "countDocuments",
  "estimatedDocumentCount",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "bulkWrite",
  "aggregate",
  "distinct",
  "createIndex",
  "toArray",
].join("|");

const PATTERNS = [
  // `\s*` before the method is load-bearing: chained calls are usually
  // formatted with the method on the next line.
  { re: new RegExp(`\\.\\s*(?:${MONGO_ONLY_METHODS})\\s*\\(`, "g"), what: "calls a MongoDB collection/cursor method" },
  // `new ObjectId(...)` without importing mongodb is a ReferenceError that a
  // surrounding try/catch will happily swallow — statuses.js#findTimelineItemById
  // did exactly that and silently 404'd every /context request. Flag the
  // CONSTRUCTOR, not just the import.
  { re: /new\s+ObjectId\s*\(/g, what: "constructs an ObjectId" },
  { re: /from\s+["']mongodb["']/g, what: 'imports from "mongodb"' },
  { re: /from\s+["'](?:\.\.\/)+storage\//g, what: "imports lib/storage/* (go through lib/core/*)" },
];

/**
 * Scan one module's source for boundary violations.
 *
 * Comments are blanked IN PLACE — same-length filler keeps every byte offset,
 * so reported line numbers match the real file. (Deleting them shifted every
 * subsequent line in an earlier version and pointed at unrelated code.)
 *
 * @param {string} source
 * @returns {Array<{line: number, what: string, text: string}>}
 */
export function scanSource(source) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, blank);

  const hits = [];
  for (const { re, what } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(code)) !== null) {
      const line = code.slice(0, match.index).split("\n").length;
      hits.push({ line, what, text: match[0].replace(/\s+/g, " ").trim() });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

async function* walk(dir) {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(rel);
    else if (entry.name.endsWith(".js")) yield rel;
  }
}

async function main() {
  const violations = [];
  const cleared = [];

  for (const dir of ADAPTER_DIRS) {
    for await (const file of walk(dir)) {
      const hits = scanSource(await readFile(join(ROOT, file), "utf8"));

      if (hits.length > 0 && !NOT_YET_PORTED.has(file)) {
        violations.push({ file, hits });
      } else if (hits.length === 0 && NOT_YET_PORTED.has(file)) {
        cleared.push(file);
      }
    }
  }

  if (cleared.length > 0) {
    console.log(
      "\nThese are now clean — remove them from NOT_YET_PORTED in this script:",
    );
    for (const file of cleared) console.log(`  ${file}`);
  }

  if (violations.length === 0) {
    console.log("\n✓ Adapter boundary holds. No adapter touches Mongo or storage directly.");
    process.exit(0);
  }

  console.error("\n✗ Adapter boundary violated.\n");
  console.error(
    "An adapter translates transport to core and back. It must not build\n" +
      "queries — that is how the two lanes drifted apart in the first place.\n" +
      "Move the logic into lib/core/*, or (last resort) add the file to\n" +
      "NOT_YET_PORTED with a reason.\n",
  );

  for (const { file, hits } of violations) {
    console.error(`  ${relative(".", file)}`);
    for (const hit of hits) {
      console.error(`    :${hit.line}  ${hit.what}`);
      console.error(`             ${hit.text.slice(0, 96)}`);
    }
  }

  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
