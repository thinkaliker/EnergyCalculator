#!/usr/bin/env node
// Find and download past revisions of an SDG&E rate schedule.
//
//   node fetch-rate-history.mjs probe <SCHEDULE> [fromYear] [toYear]
//   node fetch-rate-history.mjs get   <SCHEDULE> <M-D-YY> <out.pdf>
//
// WHY THIS EXISTS: a billing period can span a rate change, so the calculator
// needs the revision that was in force on each day, not just the current one.
// That means an archive, and an archive means finding what the archive should
// contain.
//
// WHERE THE HISTORY IS: not in the tariff viewer's API. That serves the current
// sheet and a pending one, with no history endpoint (probed: /tariffhistory,
// /tariffs/history, /tariffversions, /sheets all 404). What SDG&E does keep is
// the dated Total Rates Table PDFs, which stay at their original URLs long after
// they stop being current:
//
//   /sites/default/files/regulatory/<M-D-YY> Schedule <NAME> Total Rates Table.pdf
//
// Confirmed live on 2026-07-19 for 1-1-24, 6-1-25, 10-1-25, 1-1-26, 4-1-26 and
// 6-1-26 on TOU-DR1. There is no index of them, and the cadence is irregular —
// 3-1-26 and 5-1-26 do not exist — so the dates have to be probed rather than
// generated from a rule. That is what `probe` is for.
//
// Do NOT use /sites/default/files/elec_elec-scheds_<name>.pdf. Those rank first
// in search and look canonical, but many are the Jan 2018 revision.
//
// THIS SCRIPT DOES NOT EXTRACT. It finds and downloads; turning a PDF into a
// rate file is the rate-extractor skill's job, and that path ends in a human
// review rather than a commit. Reading a rate off a PDF without checking the
// effective date printed on it is how a 2018 sheet gets treated as current.

import { writeFileSync } from "node:fs";

const BASE = "https://www.sdge.com/sites/default/files/regulatory";

const url = (schedule, date) =>
  `${BASE}/${encodeURIComponent(`${date} Schedule ${schedule} Total Rates Table.pdf`)}`;

// A 404 here still returns a body — the site's error page — so the status is the
// only thing worth trusting. HEAD is enough and avoids pulling PDFs to discard.
async function exists(schedule, date) {
  const res = await fetch(url(schedule, date), { method: "HEAD", redirect: "follow" });
  return res.ok && (res.headers.get("content-type") ?? "").includes("pdf");
}

const isoOf = (date) => {
  const [m, d, y] = date.split("-").map(Number);
  return `20${String(y).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

async function probe(schedule, fromYear = 2024, toYear = new Date().getFullYear()) {
  if (!schedule) usage();

  // Revisions land on the 1st in practice. Probing every day of every month
  // would be 30x the requests to find the same dates, so the 1st is the rule and
  // anything else would show up as a gap in the effective dates on the PDFs
  // themselves — which the extractor reads anyway.
  const candidates = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) candidates.push(`${m}-1-${String(y).slice(2)}`);
  }

  console.log(`Probing ${candidates.length} dates for Schedule ${schedule}...\n`);
  const hits = [];
  for (const date of candidates) {
    if (await exists(schedule, date)) {
      hits.push(date);
      console.log(`  ${date.padEnd(9)} ${isoOf(date)}`);
    }
  }

  if (!hits.length) {
    console.error(`\nNothing found. Check the schedule name — it is the tariff's own ` +
      `ID as it appears in the filename, e.g. TOU-DR1, EV-TOU-5, DR.`);
    process.exit(1);
  }
  console.log(`\n${hits.length} revision(s). Download one with:`);
  console.log(`  node fetch-rate-history.mjs get ${schedule} ${hits[0]} out.pdf`);
}

async function get(schedule, date, out) {
  if (!schedule || !date || !out) usage();

  const res = await fetch(url(schedule, date), { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} — no revision published for ${date}?`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("pdf")) throw new Error(`expected a PDF, got ${type}`);

  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, buf);
  console.log(`Wrote ${out} (${buf.length} bytes), effective ${isoOf(date)}.`);
  console.log(`\nRead it with:  pdftotext -layout ${out} -`);
  console.log(`Check the effective date printed in the document before using any number from it.`);
}

function usage() {
  console.error("Usage:\n" +
    "  fetch-rate-history.mjs probe <SCHEDULE> [fromYear] [toYear]\n" +
    "  fetch-rate-history.mjs get   <SCHEDULE> <M-D-YY> <out.pdf>");
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "probe") await probe(rest[0], Number(rest[1]) || undefined, Number(rest[2]) || undefined);
  else if (cmd === "get") await get(rest[0], rest[1], rest[2]);
  else usage();
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
