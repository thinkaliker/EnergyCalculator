#!/usr/bin/env node
// Build rates/nbt-export.json — the Net Billing Tariff (NEM 3.0) export price table.
//
//   node fetch-nbt-export.mjs [--years 2025,2026] [--out rates/nbt-export.json]
//
// Under Schedule NBT, exports are not credited at retail. They earn an Energy
// Export Credit priced from the CPUC Avoided Cost Calculator, and SDG&E is
// required by CPUC Resolution E-5301 to publish 20 years of those values. It
// does so as a MIDAS upload: a ~40 MB CSV inside a 3 MB zip, one zip per
// vintage.
//
// The published file is far larger than the information in it. There is one row
// per hour of every year through 2046, but the values only vary by month, day
// type and hour — every Tuesday in January at 5pm carries the same number. This
// script collapses that back down to what it is: 12 x 3 x 24 values per
// component, per vintage, per year. Two years of all three vintages is ~120 KB
// of JSON rather than ~120 MB of CSV.
//
// Rerun each January, when the ACC vintage updates and a new LY zip appears.
//
// Requires `unzip` on PATH (Node ships no zip reader).

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BASE = "https://www.sdge.com/sites/default/files";

// One zip per vintage. NBT25/NBT26 are the nine-year lock-in schedules for
// customers who applied in that year; NBT00 is for everyone who does not
// qualify for a lock-in, and is the one that changes every January.
const VINTAGES = {
  NBT25: "LY2025%20NBT%20Pricing%20Upload%20MIDAS.zip",
  NBT26: "LY2026%20NBT%20Pricing%20Upload%20MIDAS.zip",
  NBT00: "CurrentYearNBTPricingUploadMIDAS.zip",
};

// The RateLookupID encodes which half of the bill the credit lands on. Both are
// real money to the customer; the delivery half is just an order of magnitude
// smaller, and it is the half a CCA customer still gets from SDG&E.
const COMPONENT_BY_RIN = { XXSD: "generation", SDXX: "delivery" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** DayStart/DayEnd is 1-7 for Mon-Sun and 8 for a holiday. */
const dayTypeOf = (dayStart) => (dayStart === 8 ? "holiday" : dayStart >= 6 ? "weekend" : "weekday");

// Declared up here rather than beside pacificYear() because the work below runs
// at module top level, before anything further down has initialized.
const yearFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
});
const yearCache = new Map();

const args = parseArgs(process.argv.slice(2));
const years = (args.years ?? "2025,2026").split(",").map((y) => y.trim());
const out = args.out ?? "rates/nbt-export.json";
const cacheDir = join(tmpdir(), "nbt-export-cache");

const table = {};
const problems = [];

for (const [vintage, file] of Object.entries(VINTAGES)) {
  const zip = await download(file, `${vintage}.zip`);
  process.stderr.write(`Reading ${vintage}…`);
  table[vintage] = await readVintage(zip, years);
  const got = Object.keys(table[vintage]);
  if (!got.length) problems.push(`${vintage}: no rows for any of ${years.join(", ")}.`);
  process.stderr.write(` ${got.length ? got.join(", ") : "nothing"}\n`);
}

const doc = {
  type: "export_prices",
  provider: "sdge",
  effective_date: `${Math.min(...years.map(Number))}-01-01`,
  source_url: "https://www.sdge.com/solar/solar-billing-plan/export-pricing",
  verified_against:
    "SDG&E NBT Pricing Upload (MIDAS) zips, published under CPUC Resolution E-5301; " +
    "Schedule NBT, Cal. P.U.C. tarfKey 1064.",
  _generated_by: ".claude/skills/rate-extractor/scripts/fetch-nbt-export.mjs",
  _generated_at: new Date().toISOString().slice(0, 10),
  _keying:
    "vintages -> vintage -> calendar year -> component -> month (1-12) -> day type -> 24 hourly $/kWh, " +
    "index 0 = midnight Pacific prevailing time.",
  _day_types:
    "weekday | weekend. Taken from the source's DayStart column (1-7 = Mon-Sun, 8 = holiday); the ValueName " +
    "column labels holiday rows 'Weekend', so do not key off it. Holidays are priced from the weekend row: " +
    "the source's holiday values are identical to its weekend values, and the generator asserts that for " +
    "every month carrying both before dropping the duplicate. Five months (Mar, Apr, Jun, Aug, Oct) contain " +
    "no Rule 1 holiday and so publish no holiday rows at all, which is the other reason not to store them.",
  _timezone:
    "The source's DateStart/TimeStart are UTC; DayStart and ValueName are Pacific prevailing time. Month, " +
    "hour and day type are read from the Pacific-time columns so DST never enters them. The calendar year " +
    "has to come from the UTC timestamp, converted — a Pacific evening on Dec 31 is stamped Jan 1 UTC, and " +
    "reading the year off the raw date files those hours under the wrong year.",
  _components:
    "generation = RateLookupID USCA-XXSD, delivery = USCA-SDXX. SDG&E states the generation half applies to " +
    "non-CCA customers only; SDCP and CEA use these same values as their base and add a flat adder, carried " +
    "as nbt_generation_adder_per_kwh in each CCA overlay.",
  _vintages:
    "NBT25 and NBT26 are the nine-year locked schedules for customers who applied in that year. NBT00 is for " +
    "customers with no lock-in and is re-issued every January — refresh this file then.",
  years,
  vintages: table,
};

writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");

const cells = Object.values(table).reduce(
  (n, v) => n + Object.keys(v).length * 2 * 12 * 2 * 24,
  0,
);
const coverage = Object.entries(table)
  .map(([v, byYear]) => `${v} (${Object.keys(byYear).join(", ") || "none"})`)
  .join(", ");
console.log(`Wrote ${out} — ${coverage}, ${cells} values.`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

async function download(remote, local) {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, local);
  if (existsSync(path)) return path;

  process.stderr.write(`Downloading ${remote}…`);
  const res = await fetch(`${BASE}/${remote}`);
  if (!res.ok) throw new Error(`${remote}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  process.stderr.write(" done\n");
  return path;
}

/**
 * Collapse one vintage's CSV to {year: {component: {month: {dayType: [24]}}}}.
 *
 * Streamed rather than read whole: the CSV is ~40 MB and only about 0.3% of it
 * survives. Every bucket is written many times over — once per matching day of
 * the year — so a disagreement between two rows in the same bucket means the
 * published values vary by something this shape cannot hold. That is a
 * correctness problem, not a rounding one, so it is collected and reported.
 */
async function readVintage(zipPath, wantYears) {
  const name = await csvNameInside(zipPath);
  const child = spawn("unzip", ["-p", zipPath, name], { stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (e) => {
    throw new Error(`could not run unzip: ${e.message}`);
  });

  const result = {};
  const want = new Set(wantYears);
  let header = true;

  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (header) {
      header = false;
      continue;
    }
    if (!line) continue;

    // Fixed 13-column CSV with no quoting or embedded commas.
    const f = line.split(",");
    if (f.length < 10) continue;

    // Cheap pre-filter on the raw UTC year before paying for the timezone
    // conversion. A wanted Pacific year can only appear on a UTC date stamped
    // with that year or the one after it, never earlier: Pacific is behind UTC.
    const utcYear = Number(f[2].slice(f[2].lastIndexOf("/") + 1));
    if (!want.has(String(utcYear)) && !want.has(String(utcYear - 1))) continue;

    const year = pacificYear(f[2], f[3]);
    if (!want.has(year)) continue;

    const component = COMPONENT_BY_RIN[f[0].slice(5, 9)];
    if (!component) continue;

    const [monthLabel, , hourSlot] = f[8].split(" ");
    const month = MONTHS.indexOf(monthLabel) + 1;
    const hour = Number(hourSlot.slice(2));
    const dayType = dayTypeOf(Number(f[6]));
    const value = Number(f[9]);

    if (!month || !Number.isFinite(hour) || !Number.isFinite(value)) {
      problems.push(`unparseable row: ${line.slice(0, 120)}`);
      continue;
    }

    const bucket = ((((result[year] ??= {})[component] ??= {})[month] ??= {})[dayType] ??= []);
    if (bucket[hour] === undefined) {
      bucket[hour] = value;
    } else if (bucket[hour] !== value) {
      problems.push(
        `${year} ${component} month ${month} ${dayType} hour ${hour}: ` +
          `two different values (${bucket[hour]} and ${value}) — the published table varies by more than ` +
          `month/day-type/hour and this shape cannot represent it.`,
      );
    }
  }

  await new Promise((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
  });

  foldHolidaysIntoWeekend(result);
  // Each vintage's schedule begins in its own interconnection year, so NBT26
  // publishes nothing for 2025. Check the years it does carry rather than every
  // year asked for; a vintage that turns out to carry none at all is caught by
  // the caller.
  checkComplete(result, Object.keys(result));
  return result;
}

/**
 * Holidays are priced from the weekend row, so the holiday copy is redundant —
 * but only as long as it stays identical. Check that here and drop it, rather
 * than storing a duplicate that could silently drift out of agreement, or
 * assuming the equality without ever looking.
 */
function foldHolidaysIntoWeekend(result) {
  for (const [year, components] of Object.entries(result)) {
    for (const [component, months] of Object.entries(components)) {
      for (const [month, dayTypes] of Object.entries(months)) {
        const { holiday, weekend } = dayTypes;
        if (!holiday) continue; // Months with no Rule 1 holiday publish no such rows.
        for (let hour = 0; hour < 24; hour++) {
          if (holiday[hour] !== weekend?.[hour]) {
            problems.push(
              `${year} ${component} month ${month} hour ${hour}: holiday value ${holiday[hour]} differs ` +
                `from weekend ${weekend?.[hour]}. Holidays can no longer be folded into the weekend row — ` +
                `store them separately and teach the engine to look them up.`,
            );
          }
        }
        delete dayTypes.holiday;
      }
    }
  }
}

/** A silently missing hour would price that hour's exports at zero. */
function checkComplete(result, wantYears) {
  for (const year of wantYears) {
    for (const component of ["generation", "delivery"]) {
      for (let month = 1; month <= 12; month++) {
        for (const dayType of ["weekday", "weekend"]) {
          const hours = result[year]?.[component]?.[month]?.[dayType];
          if (!hours || hours.length !== 24 || hours.some((h) => h === undefined)) {
            problems.push(
              `${year} ${component} month ${month} ${dayType}: expected 24 hourly values, got ` +
                `${hours ? hours.filter((h) => h !== undefined).length : 0}.`,
            );
          }
        }
      }
    }
  }
}

/**
 * Calendar year in Pacific prevailing time of a UTC "M/D/YYYY" + "H:MM:SS".
 *
 * Only the year is taken from here; month and hour come from the file's own
 * Pacific-time ValueName column. Cached because the conversion is the most
 * expensive thing in the loop and there are only a few thousand distinct
 * timestamps that survive the pre-filter.
 */
function pacificYear(dateStr, timeStr) {
  const key = `${dateStr} ${timeStr}`;
  let year = yearCache.get(key);
  if (year === undefined) {
    const [month, day, y] = dateStr.split("/").map(Number);
    const [hh, mm, ss] = timeStr.split(":").map(Number);
    year = yearFormatter.format(new Date(Date.UTC(y, month - 1, day, hh, mm, ss)));
    yearCache.set(key, year);
  }
  return year;
}

function csvNameInside(zipPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-Z1", zipPath]);
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.on("error", (e) => reject(new Error(`could not run unzip: ${e.message}`)));
    child.on("close", () => {
      const csv = buf.split("\n").find((n) => n.trim().endsWith(".csv"));
      csv ? resolve(csv.trim()) : reject(new Error(`no .csv inside ${zipPath}`));
    });
  });
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument "${argv[i]}"`);
    o[argv[i].slice(2)] = argv[i + 1];
  }
  return o;
}
