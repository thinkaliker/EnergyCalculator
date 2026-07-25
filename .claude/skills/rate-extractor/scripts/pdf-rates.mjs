#!/usr/bin/env node
// Extract only the rate-bearing lines from a tariff PDF, cheaply.
//
//   node pdf-rates.mjs <pdf> [outTxt]
//
// The old workflow ran `pdftotext -layout x.pdf -`, which pipes the whole
// multi-sheet document into the reader's context. A residential schedule is
// several sheets of legal boilerplate around one rate table, and a full
// extraction reads eight or so of them — so almost all of that context was
// prose no number ever came from.
//
// This writes the full text to a file instead of stdout, then prints only the
// lines that could carry a rate, each tagged with its page. The full text stays
// on disk: when a printed number needs its surrounding rows to place correctly
// (a season legend a page away, a footnote adjustment), grep or read that one
// file rather than re-dumping the PDF.
//
// Requires pdftotext (`brew install poppler`), same as before.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [pdf, outArg] = process.argv.slice(2);
if (!pdf) {
  console.error("Usage: pdf-rates.mjs <pdf> [outTxt]");
  process.exit(2);
}

// Default the text file next to nothing the repo tracks — /tmp, keyed by the
// PDF's own name so two schedules don't collide.
const out = outArg ?? `/tmp/${basename(pdf).replace(/\.pdf$/i, "")}.txt`;

try {
  execFileSync("pdftotext", ["-layout", pdf, out]);
} catch (e) {
  console.error(`ERROR pdftotext failed: ${e.message}`);
  console.error("Is poppler installed?  brew install poppler");
  process.exit(1);
}

const text = readFileSync(out, "utf8");
// pdftotext separates pages with a form-feed. Keep the index so each kept line
// can name the page it came from.
const pages = text.split("\f");

// A line worth keeping carries a price, a season or period label, a tier
// boundary, or the provenance a `verified_against` string needs. Broad on
// purpose: a missed rate line is a silently wrong extraction, an extra prose
// line is cheap. Covers both electric ($/kWh, hour windows) and gas
// ($/therm, no TOU) tariffs.
const KEEP = new RegExp(
  [
    "\\$", "¢", "per\\s*kWh", "per\\s*therm",
    "baseline", "\\btotal\\b", "summer", "winter",
    "on-?peak", "off-?peak", "super", "weekday", "weekend",
    "\\d{1,2}:\\d{2}", "\\d{1,2}\\s*(?:am|pm)\\b",
    "service\\s*charge", "advice\\s*ltr", "sheet\\s*\\d", "effective",
    "cal\\.?\\s*p\\.?u\\.?c", "up\\s*to", "above", "%\\s*of\\s*baseline",
  ].join("|"),
  "i",
);

console.log(`${basename(pdf)} — ${pages.length} page(s), full text at ${out}\n`);

let kept = 0;
pages.forEach((page, i) => {
  for (const line of page.split("\n")) {
    if (!line.trim() || !KEEP.test(line)) continue;
    console.log(`p${i + 1}: ${line.trimEnd()}`);
    kept++;
  }
});

if (!kept) {
  console.error(
    `\nNo rate-bearing lines matched. The table may be an image (scanned PDF), ` +
    `or the layout broke the patterns — read ${out} directly.`,
  );
}
