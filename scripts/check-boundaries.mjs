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
  "lib/mastodon/routes/filters.js",
  "lib/mastodon/routes/instance.js",
  "lib/mastodon/routes/media.js",
  "lib/mastodon/routes/oauth.js",
  "lib/mastodon/routes/statuses.js",
  "lib/mastodon/routes/stubs.js",
]);

/** Direct collection access — the thing adapters must not do. */
const MONGO_PATTERNS = [
  { re: /from\s+["']mongodb["']/, what: 'imports from "mongodb"' },
  { re: /collections\.\w+\.(find|findOne|aggregate|countDocuments|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite)\(/, what: "queries a collection directly" },
  { re: /collections\.get\(["'][^"']+["']\)\.(find|findOne|aggregate|countDocuments|updateOne|updateMany|deleteOne|bulkWrite)\(/, what: "queries a collection directly" },
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
    const lines = source.split("\n");

    const hits = [];
    lines.forEach((line, i) => {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
      for (const { re, what } of MONGO_PATTERNS) {
        if (re.test(line)) hits.push({ line: i + 1, what, text: line.trim() });
      }
    });

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
