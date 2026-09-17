#!/usr/bin/env node
// Backfill people tags for existing sounds from audio metadata + filenames.
// Usage:
//   node scripts/autotag.js            # dry run — print proposed tags
//   node scripts/autotag.js --apply    # apply proposed tags to sounds.json
//   node scripts/autotag.js --apply <name>  # only one sound
import fs from "node:fs/promises";
import path from "node:path";
import { getSounds, knownPeople, setPeople, SOUNDS_DIR } from "../src/sounds.js";
import { detectPeople, readTags } from "../src/autotag.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const only = args.find((a) => !a.startsWith("-"));

const sounds = getSounds();
const known = knownPeople();
const names = Object.keys(sounds)
  .filter((n) => !only || n === only.toLowerCase())
  .sort();
if (only && !names.length) {
  console.error(`not found: ${only}`);
  process.exit(1);
}

let proposed = 0;
for (const name of names) {
  const entry = sounds[name];
  const fp = path.join(SOUNDS_DIR, entry.filename);
  let buf;
  try {
    buf = await fs.readFile(fp);
  } catch {
    console.warn(`${name}: file missing (${entry.filename}), skipped`);
    continue;
  }
  const tags = await readTags(buf, entry.contentType);
  const detected = detectPeople(
    { name, filename: entry.filename, tags },
    known,
  ).filter((p) => !(entry.people || []).includes(p));
  if (!detected.length) continue;
  proposed++;
  if (APPLY) {
    await setPeople(name, [...(entry.people || []), ...detected]);
    console.log(`${name}: +${detected.join(", ")} (applied)`);
  } else {
    console.log(`${name}: +${detected.join(", ")}`);
  }
}
console.log(
  `${proposed} sound(s) with new tags${APPLY ? " applied" : " (dry run — rerun with --apply)"}.`,
);
