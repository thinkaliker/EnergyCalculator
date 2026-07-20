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

// Past revisions live in a subdirectory and get their own manifest. They are
// kept out of the main one because the page loads everything the main manifest
// names at startup, and the archive is fetched only once a usage file's date
// range says which revisions are actually needed.
//
// readdirSync returns files only here — subdirectories are dropped by the
// .json filter above — so the archive cannot leak into the main manifest by
// accident.
const historyDir = join(dir, "history");

const problems = [];
// entry object -> the identity that must be unique per effective_date.
const identity = new Map();

function indexOf(fromDir, names) {
  const entries = [];
  for (const f of names) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(fromDir, f), "utf8"));
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
    // What makes a document the same document across revisions. `rate_group`
    // belongs in it: SDCP publishes one PowerOn per enrollment vintage, so
    // provider + product alone names three different files with one date.
    identity.set(entry, [doc.provider, doc.type, doc.product ?? "", doc.rate_group ?? ""].join("|"));
    entries.push(entry);
  }
  return entries;
}

const entries = indexOf(dir, files);

let historyFiles = [];
try {
  historyFiles = readdirSync(historyDir).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
} catch {
  // No archive yet. Not a problem — the calculator falls back to the current
  // revision for every day, which is what it did before the archive existed.
}
const historyEntries = indexOf(historyDir, historyFiles);

// Two revisions of one document claiming the same effective date makes
// resolution depend on load order. js/revisions.js throws on it at runtime;
// catching it here means it never reaches a deploy.
const seen = new Map();
for (const e of [...entries, ...historyEntries]) {
  const key = identity.get(e);
  const dates = seen.get(key) ?? new Set();
  if (dates.has(e.effective_date)) {
    problems.push(`${e.path}: ${key.replace(/\|/g, " ").trim()} already has a revision effective ${e.effective_date}`);
  }
  dates.add(e.effective_date);
  seen.set(key, dates);
}

// An archived revision that is newer than the current file means the two have
// been swapped — the archive would then win for recent days and quietly reprice
// the present.
for (const h of historyEntries) {
  const current = entries.find((e) => identity.get(e) === identity.get(h));
  if (current && h.effective_date >= current.effective_date) {
    problems.push(
      `history/${h.path}: effective ${h.effective_date} is not older than the current ` +
        `${current.path} (${current.effective_date}) — promote it instead of archiving it`,
    );
  }
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

// Newest first here too, so a resolver scanning for "the revision in force on
// this day" stops at the first match.
if (historyEntries.length) {
  historyEntries.sort((a, b) =>
    a.provider.localeCompare(b.provider) ||
    (a.product ?? "").localeCompare(b.product ?? "") ||
    b.effective_date.localeCompare(a.effective_date));
  const historyOut = join(historyDir, "index.json");
  writeFileSync(historyOut, `${JSON.stringify({ generated, files: historyEntries }, null, 2)}\n`);
  console.log(`Wrote ${historyOut} — ${historyEntries.length} archived revision(s).`);
}
