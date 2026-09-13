/**
 * The boundary check is the refactor's lock (plan Stage 5). It passed for a
 * month while ~60 direct Mongo calls sat in 15 controllers, because it matched
 * receiver NAMES (`collections.x.find(`) and any other variable walked past it.
 * These cases are the real evasions found in the 2026-09-13 audit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scanSource } from "../scripts/check-boundaries.mjs";

const flagged = (code) => scanSource(code).length > 0;

describe("check-boundaries scanSource — must flag", () => {
  const cases = {
    "direct collections.x call": `await collections.ap_timeline.findOne({ uid });`,
    "destructured collection (compose.js)": `const { ap_timeline } = collections;\nawait ap_timeline.findOne({ uid });`,
    "arbitrary variable name (dashboard.js)": `await followersCollection.countDocuments();`,
    "optional chaining (federation-mgmt.js)": `pluginCollections.ap_blocked?.find({}).toArray();`,
    "method on the next line": `await apProfile\n  .updateOne({}, { $set: x });`,
    "a find() cursor, via toArray": `const rows = await col.find({}).sort({ a: 1 }).toArray();`,
    "aggregate": `await things.aggregate([]).toArray();`,
    "ObjectId construction": `const id = new ObjectId(req.params.id);`,
    "mongodb import": `import { ObjectId } from "mongodb";`,
    "storage import (adapters go through core)": `import { getFollowedTags } from "../storage/followed-tags.js";`,
    "storage import, deeper path": `import { addTimelineItem } from "../../storage/timeline.js";`,
  };

  for (const [name, code] of Object.entries(cases)) {
    it(name, () => assert.ok(flagged(code), code));
  }
});

describe("check-boundaries scanSource — must NOT flag", () => {
  const cases = {
    "Array.prototype.find": `const hit = items.find((x) => x.id === id);`,
    "Map.get of a collection handed to core": `const c = { ap_timeline: application.collections.get("ap_timeline") };\nawait getTimeline(c, options);`,
    "core import": `import { getTimeline } from "../core/timeline.js";`,
    "a mention inside a block comment": `/* we used to call collections.ap_timeline.findOne( here */`,
    "a mention inside a line comment": `// ap_timeline.countDocuments() moved to core`,
  };

  for (const [name, code] of Object.entries(cases)) {
    it(name, () => assert.equal(flagged(code), false, code));
  }
});
