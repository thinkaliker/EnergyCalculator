#!/usr/bin/env node
// Regenerate rates/index.json from the rate files on disk.
// Usage: node reindex.mjs <rates-dir>
//
// GitHub Pages serves no directory listings, so this manifest is the only way
// the page discovers what rate files exist. Generated, never hand-edited.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Also the manifest's sort order: the page loads the utility file first, then
// generation overlays, then the NEM 3.0 export price table.
const TYPES = ["utility", "generation", "export_prices", "cities"];

const dir = process.argv[2] ?? "rates";

let files;
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json" && f !== "zips.json")
    .sort();
} catch (e) {
  console.error(`Cannot read rates directory "${dir}": ${e.message}`);
  process.exit(2);
}

const entries = [];
const problems = [];

for (const f of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch (e) {
    problems.push(`${f}: invalid JSON: ${e.message}`);
    continue;
  }
  for (const field of ["provider", "type", "effective_date"]) {
    if (!doc[field]) problems.push(`${f}: missing ${field}`);
  }
  // The manifest is sorted and searched on these two, so check their shape here
  // even though validate.mjs covers them more thoroughly — a malformed date
  // would silently break the app's "most recent rates" lookup.
  if (doc.effective_date && !/^\d{4}-\d{2}-\d{2}$/.test(doc.effective_date)) {
    problems.push(`${f}: effective_date must be YYYY-MM-DD, got ${JSON.stringify(doc.effective_date)}`);
  }
  if (doc.type && !TYPES.includes(doc.type)) {
    problems.push(`${f}: type must be one of ${TYPES.join(", ")}, got ${JSON.stringify(doc.type)}`);
  }
  const entry = {
    provider: doc.provider,
    type: doc.type,
    effective_date: doc.effective_date,
    path: f,
  };
  if (doc.product) entry.product = doc.product;
  entries.push(entry);
}

if (problems.length) {
  for (const p of problems) console.error(`ERROR ${p}`);
  console.error("\nManifest not written. Fix the rate files first.");
  process.exit(1);
}

// Utility file first, then generation overlays, then the export price table —
// so the app's "most recent rates" lookup reads top-down.
entries.sort((a, b) =>
  TYPES.indexOf(a.type) - TYPES.indexOf(b.type) ||
  a.provider.localeCompare(b.provider) ||
  b.effective_date.localeCompare(a.effective_date));

// Local date, not UTC — a manifest stamped a day ahead of the machine that
// wrote it is confusing when reviewing the diff.
const now = new Date();
const generated = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-");

const manifest = { generated, files: entries };

const out = join(dir, "index.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out} — ${entries.length} rate file(s).`);
