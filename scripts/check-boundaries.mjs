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
 * The allowlist below is DEBT, not policy. Every entry is a module not yet
 * ported to lib/core/*. It must only ever shrink — adding to it is how the
 * rule dies quietly.
 *
 * Usage: node scripts/check-boundaries.mjs
 * Exit 0 clean, 1 on violation.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories whose modules are adapters: transport in, transport out. */
const ADAPTER_DIRS = ["lib/controllers", "lib/mastodon/routes", "lib/mastodon/helpers"];

/**
 * Modules not yet ported to lib/core/*. SHRINK ONLY.
 *
 * Each of these still builds its own queries. None has a known defect — which
 * is exactly why they were left until last — but each is a place where the two
 * lanes could diverge again.
 */
const NOT_YET_PORTED = new Set([
  "lib/mastodon/helpers/pagination.js",
  "lib/mastodon/routes/accounts.js",
  "lib/mastodon/routes/oauth.js",
]);

/**
 * Direct collection access — the thing adapters must not do.
 *
 * `\s*` between the collection and the method is load-bearing. An earlier
 * line-by-line version of this script missed
 *
 *   await collections.ap_idempotency
 *     .insertOne({ ... })
 *
 * because the method sat on the next line. Matching against the whole file
 * with a whitespace-tolerant pattern closes that hole.
 */
const METHODS =
  "find|findOne|aggregate|countDocuments|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|replaceOne|findOneAndUpdate|distinct";

const MONGO_PATTERNS = [
  // `new ObjectId(...)` without importing mongodb is a ReferenceError that a
  // surrounding try/catch will happily swallow — statuses.js#findTimelineItemById
  // did exactly that and silently 404'd every /context request. Flag the
  // CONSTRUCTOR, not just the import.
  { re: /new\s+ObjectId\s*\(/g, what: "constructs an ObjectId" },
  // A helper that takes the collection as a PARAMETER evades `collections.x.find(`.
  // Catch the bare method call on any identifier that looks like a collection.
  { re: /\b(?:collection|col|coll)\s*\.\s*(?:find|findOne|aggregate|countDocuments|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|distinct)\s*\(/g, what: "queries a collection passed as a parameter" },
  { re: new RegExp(`from\\s+["']mongodb["']`, "g"), what: 'imports from "mongodb"' },
  { re: new RegExp(`collections\\.\\w+\\s*\\.\\s*(?:${METHODS})\\s*\\(`, "g"), what: "queries a collection directly" },
  { re: new RegExp(`collections\\.get\\(["'][^"']+["']\\)\\s*\\.\\s*(?:${METHODS})\\s*\\(`, "g"), what: "queries a collection directly" },
];

async function* walk(dir) {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(rel);
    else if (entry.name.endsWith(".js")) yield rel;
  }
}

const violations = [];
const cleared = [];

for (const dir of ADAPTER_DIRS) {
  for await (const file of walk(dir)) {
    const source = await readFile(join(ROOT, file), "utf8");

    // Strip comments first, then match against the whole file — a chain split
    // across lines is still a query.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const hits = [];
    for (const { re, what } of MONGO_PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(code)) !== null) {
        const line = code.slice(0, match.index).split("\n").length;
        hits.push({ line, what, text: match[0].replace(/\s+/g, " ").trim() });
      }
    }

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
  console.log("\n✓ Adapter boundary holds. No unported adapter queries Mongo.");
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
