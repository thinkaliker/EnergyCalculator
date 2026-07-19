#!/usr/bin/env node
// Validate rate JSON files against the schema in references/schema.md.
// Usage: node validate.mjs <rates-dir>
//
// Catches the failure modes that are silent in the calculator: hour-block gaps
// (under-bills), unit confusion (100x/1000x errors), CCA plans that don't map
// onto any utility plan, and seasons that don't cover the year.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DAY_TYPES = ["weekday", "weekend"];

// Plausible $/kWh band for a single rate component. Deliberately wide — this
// is a unit-error tripwire, not a rate review. Widening it to silence a warning
// defeats the point; re-read the source document instead.
const PRICE_MIN = 0.01;
const PRICE_MAX = 1.5;

const errors = [];
const warnings = [];

const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

const isMonthDay = (s) => typeof s === "string" && /^\d{2}-\d{2}$/.test(s);
const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s));

/** Blocks must tile [0,24) exactly: no gap, no overlap. */
function checkBlocks(file, path, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    err(file, `${path}: expected a non-empty array of hour blocks`);
    return;
  }

  for (const [i, b] of blocks.entries()) {
    const at = `${path}[${i}]`;
    if (!Number.isInteger(b?.start_hour) || b.start_hour < 0 || b.start_hour > 23) {
      err(file, `${at}: start_hour must be an integer 0-23, got ${JSON.stringify(b?.start_hour)}`);
    }
    if (!Number.isInteger(b?.end_hour) || b.end_hour < 1 || b.end_hour > 24) {
      err(file, `${at}: end_hour must be an integer 1-24, got ${JSON.stringify(b?.end_hour)}`);
    }
    if (Number.isInteger(b?.start_hour) && Number.isInteger(b?.end_hour) && b.end_hour <= b.start_hour) {
      err(file, `${at}: end_hour must exceed start_hour (wrapping windows split into two blocks)`);
    }
    if (typeof b?.price_per_kwh !== "number" || Number.isNaN(b.price_per_kwh)) {
      err(file, `${at}: price_per_kwh must be a number, got ${JSON.stringify(b?.price_per_kwh)}`);
    } else if (b.price_per_kwh < 0) {
      err(file, `${at}: price_per_kwh is negative (${b.price_per_kwh})`);
    } else if (b.price_per_kwh < PRICE_MIN || b.price_per_kwh > PRICE_MAX) {
      warn(file, `${at}: price_per_kwh ${b.price_per_kwh} outside plausible $/kWh band ` +
        `(${PRICE_MIN}-${PRICE_MAX}) — check source units (¢/kWh? $/MWh?)`);
    }
  }

  // Tiling check. Only meaningful once the blocks are structurally sound.
  const usable = blocks.filter(
    (b) => Number.isInteger(b?.start_hour) && Number.isInteger(b?.end_hour) && b.end_hour > b.start_hour,
  );
  if (usable.length !== blocks.length) return;

  const sorted = [...usable].sort((a, b) => a.start_hour - b.start_hour);
  let cursor = 0;
  for (const b of sorted) {
    if (b.start_hour > cursor) {
      err(file, `${path}: gap in hour coverage, ${cursor}:00-${b.start_hour}:00 unpriced`);
    } else if (b.start_hour < cursor) {
      err(file, `${path}: overlapping hour blocks at ${b.start_hour}:00`);
    }
    cursor = Math.max(cursor, b.end_hour);
  }
  if (cursor < 24) err(file, `${path}: gap in hour coverage, ${cursor}:00-24:00 unpriced`);
}

/**
 * Tiers must be ordered by ascending threshold and end in an open-ended tier,
 * otherwise usage above the last threshold is unpriced — the tiered equivalent
 * of an hour gap, and just as silent.
 */
function checkTiers(file, path, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    err(file, `${path}: expected a non-empty array of tiers`);
    return;
  }

  let prev = 0;
  for (const [i, t] of tiers.entries()) {
    const at = `${path}[${i}]`;
    const last = i === tiers.length - 1;
    const cap = t?.up_to_pct_of_baseline;

    if (last) {
      if (cap !== null) {
        err(file, `${at}: the final tier must have up_to_pct_of_baseline null ` +
          `(open-ended), got ${JSON.stringify(cap)} — usage above it would be unpriced`);
      }
    } else if (typeof cap !== "number" || !(cap > 0)) {
      err(file, `${at}: up_to_pct_of_baseline must be a positive number, got ${JSON.stringify(cap)}`);
    } else if (cap <= prev) {
      err(file, `${at}: tier thresholds must ascend (${cap} follows ${prev})`);
    } else {
      prev = cap;
    }

    if (typeof t?.price_per_kwh !== "number" || Number.isNaN(t.price_per_kwh)) {
      err(file, `${at}: price_per_kwh must be a number, got ${JSON.stringify(t?.price_per_kwh)}`);
    } else if (t.price_per_kwh < 0) {
      err(file, `${at}: price_per_kwh is negative (${t.price_per_kwh})`);
    } else if (t.price_per_kwh < PRICE_MIN || t.price_per_kwh > PRICE_MAX) {
      warn(file, `${at}: price_per_kwh ${t.price_per_kwh} outside plausible $/kWh band ` +
        `(${PRICE_MIN}-${PRICE_MAX}) — check source units (¢/kWh? $/MWh?)`);
    }
  }
}

/** A season -> tiers tree, for plans priced by consumption rather than clock. */
function checkTierTree(file, path, tree, seasons) {
  if (!tree || typeof tree !== "object") {
    err(file, `${path}: missing or not an object`);
    return;
  }
  for (const season of seasons) {
    if (!(season in tree)) {
      err(file, `${path}.${season}: missing (declared in seasons)`);
      continue;
    }
    checkTiers(file, `${path}.${season}`, tree[season]);
  }
}

/** A season -> day_type -> blocks tree. */
function checkRateTree(file, path, tree, seasons) {
  if (!tree || typeof tree !== "object") {
    err(file, `${path}: missing or not an object`);
    return;
  }
  for (const season of seasons) {
    const dayTypes = tree[season];
    if (!dayTypes || typeof dayTypes !== "object") {
      err(file, `${path}.${season}: missing (declared in seasons)`);
      continue;
    }
    for (const dt of DAY_TYPES) {
      if (!(dt in dayTypes)) {
        err(file, `${path}.${season}.${dt}: missing`);
        continue;
      }
      checkBlocks(file, `${path}.${season}.${dt}`, dayTypes[dt]);
    }
  }
}

function checkProvenance(file, doc) {
  if (!isIsoDate(doc.effective_date)) {
    err(file, `effective_date must be YYYY-MM-DD, got ${JSON.stringify(doc.effective_date)}`);
  }
  if (!doc.source_url) err(file, "source_url is required");
  if (!doc.verified_against) {
    err(file, "verified_against is required (schedule name, sheet/page, revision date)");
  } else if (String(doc.verified_against).trim().length < 15) {
    warn(file, `verified_against "${doc.verified_against}" is too vague to re-find the number`);
  }
}

/** Seasons must cover all 365 day-of-year slots exactly once. */
function checkSeasons(file, seasons) {
  if (!seasons || typeof seasons !== "object" || Object.keys(seasons).length === 0) {
    err(file, "seasons: missing or empty");
    return [];
  }

  const names = Object.keys(seasons);
  // Non-leap reference year; season boundaries are month-day only.
  const covered = new Array(365).fill(0);
  const dayOfYear = (md) => {
    const [m, d] = md.split("-").map(Number);
    return Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 86400000);
  };

  for (const name of names) {
    const s = seasons[name];
    if (!isMonthDay(s?.start) || !isMonthDay(s?.end)) {
      err(file, `seasons.${name}: start and end must be MM-DD`);
      return names;
    }
    let i = dayOfYear(s.start);
    const end = dayOfYear(s.end);
    if (Number.isNaN(i) || Number.isNaN(end)) {
      err(file, `seasons.${name}: unparseable date range`);
      return names;
    }
    // Walk forward, wrapping at year end (winter spans December into January).
    for (let guard = 0; guard <= 365; guard++) {
      covered[i]++;
      if (i === end) break;
      i = (i + 1) % 365;
      if (guard === 365) {
        err(file, `seasons.${name}: range never reaches its end date`);
        return names;
      }
    }
  }

  const gaps = covered.filter((c) => c === 0).length;
  const overlaps = covered.filter((c) => c > 1).length;
  if (gaps) err(file, `seasons: ${gaps} day(s) of the year fall in no season`);
  if (overlaps) err(file, `seasons: ${overlaps} day(s) of the year fall in more than one season`);

  return names;
}

function validateUtility(file, doc) {
  checkProvenance(file, doc);
  const seasons = checkSeasons(file, doc.seasons);

  for (const k of ["pcia_per_kwh", "franchise_fee_per_kwh", "dwr_bond_per_kwh"]) {
    const v = doc.cca_adders?.[k];
    if (typeof v !== "number") err(file, `cca_adders.${k}: required number`);
    else if (v < 0) err(file, `cca_adders.${k}: negative (${v})`);
    else if (v > 0.2) warn(file, `cca_adders.${k}: ${v} looks high for an adder — check units`);
  }

  if (typeof doc.fixed_charges?.daily_service_charge !== "number") {
    err(file, "fixed_charges.daily_service_charge: required number");
  }

  if (!Array.isArray(doc.plans) || doc.plans.length === 0) {
    err(file, "plans: expected a non-empty array");
    return {};
  }

  const models = {};
  const ids = [];
  for (const [i, plan] of doc.plans.entries()) {
    const label = plan?.id ? `plans.${plan.id}` : `plans[${i}]`;
    if (!plan?.id) err(file, `${label}: id is required`);
    else if (ids.includes(plan.id)) err(file, `${label}: duplicate plan id`);
    else ids.push(plan.id);
    if (!plan?.name) err(file, `${label}: name is required`);

    // Two pricing models. "tou" prices by clock hour, "tiered" by cumulative
    // consumption against the baseline allowance — structurally different trees.
    const model = plan?.pricing_model ?? "tou";
    if (model === "tiered") {
      checkTierTree(file, `${label}.delivery`, plan?.delivery, seasons);
      checkTierTree(file, `${label}.generation`, plan?.generation, seasons);
    } else if (model === "tou") {
      checkRateTree(file, `${label}.delivery`, plan?.delivery, seasons);
      checkRateTree(file, `${label}.generation`, plan?.generation, seasons);
    } else {
      err(file, `${label}.pricing_model: must be "tou" or "tiered", got ${JSON.stringify(model)}`);
    }
    if (plan?.id) models[plan.id] = model;
  }
  return models;
}

// planModels maps utility plan id -> "tou" | "tiered". An overlay must use the
// same pricing model as the plan it overlays, or the calculator would read a
// tier array as hour blocks.
function validateGeneration(file, doc, planModels, seasons) {
  const utilityPlanIds = Object.keys(planModels);
  checkProvenance(file, doc);

  if (!doc.plans || typeof doc.plans !== "object" || Array.isArray(doc.plans)) {
    err(file, "plans: expected an object keyed by utility plan id");
    return;
  }
  // A CCA file that restates delivery means the overlay model was misunderstood.
  for (const forbidden of ["delivery", "fixed_charges", "cca_adders", "baseline"]) {
    if (forbidden in doc) {
      err(file, `${forbidden}: generation overlays must not restate utility-set charges`);
    }
  }

  // Optional per-kWh credit applied on top of the published generation prices.
  // Must be negative: a positive value here would silently inflate every bill.
  if ("generation_credit_per_kwh" in doc) {
    const c = doc.generation_credit_per_kwh;
    if (typeof c !== "number" || Number.isNaN(c)) {
      err(file, `generation_credit_per_kwh: must be a number, got ${JSON.stringify(c)}`);
    } else if (c > 0) {
      err(file, `generation_credit_per_kwh: must be negative (a credit), got ${c}`);
    } else if (c < -PRICE_MAX) {
      warn(file, `generation_credit_per_kwh: ${c} is larger than any plausible rate — check units`);
    }
  }

  for (const [planId, tree] of Object.entries(doc.plans)) {
    if (utilityPlanIds.length && !utilityPlanIds.includes(planId)) {
      err(file, `plans.${planId}: no such plan in the utility file ` +
        `(known: ${utilityPlanIds.join(", ")})`);
      continue;
    }
    if (planModels[planId] === "tiered") {
      checkTierTree(file, `plans.${planId}`, tree, seasons);
    } else {
      checkRateTree(file, `plans.${planId}`, tree, seasons);
    }
  }
}

// ---- main ----

const dir = process.argv[2] ?? "rates";

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json" && f !== "zips.json");
} catch (e) {
  console.error(`Cannot read rates directory "${dir}": ${e.message}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`No rate files found in "${dir}".`);
  process.exit(2);
}

const docs = new Map();
for (const f of files) {
  try {
    docs.set(f, JSON.parse(readFileSync(join(dir, f), "utf8")));
  } catch (e) {
    err(f, `invalid JSON: ${e.message}`);
  }
}

const utilities = [...docs].filter(([, d]) => d.type === "utility");
const generations = [...docs].filter(([, d]) => d.type === "generation");

for (const [, d] of docs) {
  if (d.type !== "utility" && d.type !== "generation") {
    err("(file)", `type must be "utility" or "generation", got ${JSON.stringify(d.type)}`);
  }
}

let planModels = {};
let seasonNames = [];
for (const [f, d] of utilities) {
  planModels = { ...planModels, ...validateUtility(f, d) };
  seasonNames = Object.keys(d.seasons ?? {});
}

if (generations.length && !utilities.length) {
  warn("(dir)", "generation overlays present but no utility file — plan ids unverifiable");
}

for (const [f, d] of generations) validateGeneration(f, d, planModels, seasonNames);

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

const checked = `${docs.size} file(s)`;
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} error(s), ${warnings.length} warning(s) across ${checked}`);
  process.exit(1);
}
console.log(`\nOK — ${checked}, ${warnings.length} warning(s). Human review still required.`);
