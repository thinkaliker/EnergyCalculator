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

// Export prices are avoided-cost values, not retail, so they need their own
// band: they run an order of magnitude below retail most of the year and spike
// above $2/kWh on September evenings.
const EXPORT_PRICE_MAX = 3.0;

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
    checkNonbypassable(file, label, plan);
    if (plan?.id) models[plan.id] = model;
  }
  return models;
}

/**
 * Non-bypassable charges, used only on the NEM 2.0 path.
 *
 * Two ways to get these wrong, both silent. A total that doesn't match its
 * components means one was misread off the UDC table. A total that exceeds the
 * plan's cheapest delivery price would make the netted delivery rate negative,
 * so exporting during super-off-peak would *earn* delivery credit — a plausible
 * looking bill built on a sign error.
 */
function checkNonbypassable(file, label, plan) {
  const nbc = plan?.nonbypassable_charges;
  if (!nbc) return; // Optional: a plan without it simply can't be costed under NEM 2.0.

  const parts = ["ppp_per_kwh", "nd_per_kwh", "ctc_per_kwh", "dwr_bc_per_kwh", "wf_nbc_per_kwh"];
  let sum = 0;
  for (const k of parts) {
    if (typeof nbc[k] !== "number" || Number.isNaN(nbc[k])) {
      err(file, `${label}.nonbypassable_charges.${k}: required number, got ${JSON.stringify(nbc[k])}`);
      return;
    }
    sum += nbc[k];
  }
  sum = Number(sum.toFixed(5));

  if (typeof nbc.total_per_kwh !== "number") {
    err(file, `${label}.nonbypassable_charges.total_per_kwh: required number`);
    return;
  }
  if (Math.abs(nbc.total_per_kwh - sum) > 1e-9) {
    err(file, `${label}.nonbypassable_charges.total_per_kwh is ${nbc.total_per_kwh} but its ` +
      `components sum to ${sum} — one of them was misread`);
  }
  if (nbc.total_per_kwh <= 0) {
    err(file, `${label}.nonbypassable_charges.total_per_kwh must be positive, got ${nbc.total_per_kwh}`);
  }

  const prices = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach((b) => prices.push(b?.price_per_kwh));
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(plan.delivery);
  const cheapest = Math.min(...prices.filter((p) => typeof p === "number"));
  if (Number.isFinite(cheapest) && nbc.total_per_kwh >= cheapest) {
    err(file, `${label}.nonbypassable_charges.total_per_kwh ${nbc.total_per_kwh} is not below the ` +
      `plan's cheapest delivery price ${cheapest} — netting it out would give a negative ` +
      `delivery rate, which credits exports instead of charging imports`);
  }
}

/**
 * City -> CCA membership and franchise fee percentage.
 *
 * The franchise fee is the reason this file exists: a city's total percentage is
 * the 1.1% base plus its differential, and getting it wrong is a whole line item
 * on every CCA bill. The CCA membership is checked against the overlays actually
 * on disk, so a city pointing at a provider we cannot price fails here rather
 * than silently offering nothing.
 */
function validateCities(file, doc, generations) {
  checkProvenance(file, doc);

  const base = doc.franchise_fee?.base_pct;
  if (typeof base !== "number" || base < 0 || base > 20) {
    err(file, `franchise_fee.base_pct: expected a percentage 0-20, got ${JSON.stringify(base)}`);
  }
  for (const [city, pct] of Object.entries(doc.franchise_fee?.differentials_pct ?? {})) {
    if (typeof pct !== "number" || pct < 0 || pct > 20) {
      err(file, `franchise_fee.differentials_pct.${city}: expected a percentage 0-20, got ${JSON.stringify(pct)}`);
    }
  }

  if (!Array.isArray(doc.cities) || !doc.cities.length) {
    err(file, "cities: expected a non-empty array");
    return;
  }

  // Which providers and rate groups we can actually price, and which cities each
  // one claims. Matched against the structured service_area_cities list rather
  // than the prose service_area: "San Diego" is a substring of "County of San
  // Diego", so substring matching silently accepts the wrong rate group.
  const providers = new Map();
  const serviceAreas = new Map();
  for (const [, g] of generations) {
    if (!providers.has(g.provider)) providers.set(g.provider, new Set());
    const group = g.rate_group ?? "";
    providers.get(g.provider).add(group);
    if (Array.isArray(g.service_area_cities)) {
      serviceAreas.set(`${g.provider}|${group}`, new Set(g.service_area_cities));
    }
  }
  // A provider with a single unnamed group needs no rate_group on its cities.
  for (const [p, groups] of providers) {
    if (groups.size === 1 && groups.has("")) providers.set(p, new Set());
  }

  const seen = new Set();
  for (const [i, c] of doc.cities.entries()) {
    const at = c?.name ? `cities.${c.name}` : `cities[${i}]`;
    if (!c?.name) { err(file, `${at}: name is required`); continue; }
    if (seen.has(c.name)) err(file, `${at}: duplicate city`);
    seen.add(c.name);

    if (c.cca == null) continue;
    const groups = providers.get(c.cca);
    if (!groups) {
      err(file, `${at}.cca: no generation overlay for provider "${c.cca}" ` +
        `(have: ${[...providers.keys()].join(", ") || "none"})`);
      continue;
    }
    // A provider that publishes several rate schedules needs the city to say
    // which one — SDCP's two differ in both price and PCIA vintage.
    if (groups.size > 1 && !c.cca_rate_group) {
      err(file, `${at}: "${c.cca}" publishes rate groups ${[...groups].join(", ")}, ` +
        `so cca_rate_group is required`);
      continue;
    }
    if (c.cca_rate_group && !groups.has(c.cca_rate_group)) {
      err(file, `${at}.cca_rate_group: "${c.cca_rate_group}" is not a rate group of ` +
        `"${c.cca}" (have: ${[...groups].join(", ")})`);
      continue;
    }

    // A rate group that exists but is the wrong one is the dangerous case: it
    // gets both the generation price and the PCIA vintage wrong, and nothing
    // downstream can tell.
    const claimed = serviceAreas.get(`${c.cca}|${c.cca_rate_group ?? ""}`);
    if (claimed && !claimed.has(c.name)) {
      const elsewhere = [...groups].find(
        (g) => g !== (c.cca_rate_group ?? "") && serviceAreas.get(`${c.cca}|${g}`)?.has(c.name),
      );
      const where = c.cca_rate_group ? `${c.cca} ${c.cca_rate_group}` : c.cca;
      if (elsewhere) {
        err(file, `${at}: "${c.name}" is served by ${c.cca} ${elsewhere}, not ${where} — ` +
          `the wrong rate group means the wrong generation price and the wrong PCIA vintage`);
      } else {
        warn(file, `${at}: "${c.name}" is not in the service area of ${where}. ` +
          `Check the CCA's published service area.`);
      }
    }
  }

  for (const city of Object.keys(doc.franchise_fee?.differentials_pct ?? {})) {
    if (!seen.has(city)) {
      warn(file, `franchise_fee.differentials_pct.${city}: no such city in the cities list`);
    }
  }
}

/**
 * The NEM 3.0 export price table: vintage -> year -> component -> month -> day
 * type -> 24 hourly $/kWh. Generated by fetch-nbt-export.mjs, so the checks here
 * are about the file being usable, not about transcription.
 *
 * A missing hour is the dangerous case: it prices that hour's exports at zero
 * rather than failing, which reads as "solar isn't worth much in the evening".
 */
function validateExportPrices(file, doc) {
  checkProvenance(file, doc);

  const vintages = doc.vintages;
  if (!vintages || typeof vintages !== "object" || !Object.keys(vintages).length) {
    err(file, "vintages: missing or empty");
    return;
  }

  for (const [vintage, byYear] of Object.entries(vintages)) {
    if (!Object.keys(byYear ?? {}).length) {
      err(file, `vintages.${vintage}: no calendar years`);
      continue;
    }
    for (const [year, components] of Object.entries(byYear)) {
      for (const component of ["generation", "delivery"]) {
        const months = components?.[component];
        if (!months) {
          err(file, `vintages.${vintage}.${year}.${component}: missing`);
          continue;
        }
        for (let month = 1; month <= 12; month++) {
          for (const dayType of ["weekday", "weekend"]) {
            const at = `vintages.${vintage}.${year}.${component}.${month}.${dayType}`;
            const hours = months[month]?.[dayType];
            if (!Array.isArray(hours) || hours.length !== 24) {
              err(file, `${at}: expected 24 hourly values, got ${hours?.length ?? "none"}`);
              continue;
            }
            for (const [hour, v] of hours.entries()) {
              if (typeof v !== "number" || Number.isNaN(v)) {
                err(file, `${at}[${hour}]: must be a number, got ${JSON.stringify(v)}`);
              } else if (v < 0) {
                err(file, `${at}[${hour}]: negative export price (${v})`);
              } else if (v > EXPORT_PRICE_MAX) {
                // ACC values genuinely spike above $2/kWh on September evenings,
                // so the ceiling here is well above the retail band.
                warn(file, `${at}[${hour}]: ${v} exceeds ${EXPORT_PRICE_MAX}/kWh — check source units`);
              }
            }
          }
        }
      }
    }
  }
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

  // Both CCAs credit NEM 3.0 exports at SDG&E's published value plus a flat
  // adder of their own. Positive: it is paid on top, unlike generation_credit.
  if ("nbt_generation_adder_per_kwh" in doc) {
    const a = doc.nbt_generation_adder_per_kwh;
    if (typeof a !== "number" || Number.isNaN(a)) {
      err(file, `nbt_generation_adder_per_kwh: must be a number, got ${JSON.stringify(a)}`);
    } else if (a < 0) {
      err(file, `nbt_generation_adder_per_kwh: must not be negative (it is paid to the customer), got ${a}`);
    } else if (a > 0.05) {
      warn(file, `nbt_generation_adder_per_kwh: ${a} is large for an export adder — ` +
        `published values are around $0.0075-$0.01. Check units and the source table.`);
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

const TYPES = ["utility", "generation", "export_prices", "cities"];
const utilities = [...docs].filter(([, d]) => d.type === "utility");
const generations = [...docs].filter(([, d]) => d.type === "generation");
const exportPrices = [...docs].filter(([, d]) => d.type === "export_prices");
const cityFiles = [...docs].filter(([, d]) => d.type === "cities");

for (const [f, d] of docs) {
  if (!TYPES.includes(d.type)) {
    err(f, `type must be one of ${TYPES.join(", ")}, got ${JSON.stringify(d.type)}`);
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
for (const [f, d] of exportPrices) validateExportPrices(f, d);
for (const [f, d] of cityFiles) validateCities(f, d, generations);

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

const checked = `${docs.size} file(s)`;
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} error(s), ${warnings.length} warning(s) across ${checked}`);
  process.exit(1);
}
console.log(`\nOK — ${checked}, ${warnings.length} warning(s). Human review still required.`);
