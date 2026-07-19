// Cost an interval series against one plan.
//
// The rule everything here follows:
//
//   total = SDG&E delivery + fixed charges + CCA adders + generation
//
// Only generation differs by provider. Switching to a CCA does not replace the
// bill; SDG&E still delivers the power and still bills for delivery, and CCA
// customers additionally pay SDG&E-set adders that bundled customers don't.
// Modelling any provider as a single flat rate produces comparisons that look
// plausible and are wrong.

import { localDateKey } from "./parse.js";
import { createCalendar } from "./calendar.js";

const priceAtHour = (blocks, hour) => {
  const b = blocks.find((x) => hour >= x.start_hour && hour < x.end_hour);
  if (!b) throw new Error(`No price covers hour ${hour} — rate file has an hour gap.`);
  return b.price_per_kwh;
};

/**
 * @param {object}   o.utility      parsed rates/sdge.json
 * @param {string}   o.planId       plan id in that file
 * @param {object[]} o.intervals    from parse.js
 * @param {object}  [o.overlay]     CCA generation overlay; omit for bundled SDG&E
 * @param {string}  [o.climateZone] coastal | inland | mountain | desert
 * @param {string}  [o.baselineType] basic | all_electric
 * @param {number}  [o.pciaVintage] year the customer left bundled service
 * @param {boolean} [o.inCityOfSanDiego] drives the franchise fee differential
 */
export function costPlan({
  utility,
  planId,
  intervals,
  overlay = null,
  climateZone = "coastal",
  baselineType = "basic",
  pciaVintage = null,
  inCityOfSanDiego = false,
}) {
  const plan = utility.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`No plan "${planId}" in the rate file.`);

  const calendar = createCalendar(utility);
  const model = plan.pricing_model ?? "tou";
  const isCCA = Boolean(overlay);
  const notes = [];
  const warnings = [];

  if (isCCA && !overlay.plans[planId]) {
    throw new Error(`${overlay.product ?? overlay.provider} does not serve plan "${planId}".`);
  }

  // Per-season accumulation. Tiered plans need season totals before they can be
  // priced at all, and TOU plans need the same buckets for the breakdown, so
  // both models share this pass.
  const bySeason = new Map();
  const bucket = (season) => {
    if (!bySeason.has(season)) {
      bySeason.set(season, { kWh: 0, days: new Set(), delivery: 0, generation: 0 });
    }
    return bySeason.get(season);
  };

  const allDays = new Set();

  for (const iv of intervals) {
    const season = calendar.seasonOf(iv.start);
    const dayType = calendar.dayTypeOf(iv.start);
    const hour = iv.start.getHours();
    const b = bucket(season);
    const dayKey = localDateKey(iv.start);

    b.kWh += iv.kWh;
    b.days.add(dayKey);
    allDays.add(dayKey);

    if (model === "tou") {
      b.delivery += iv.kWh * priceAtHour(plan.delivery[season][dayType], hour);
      const genTree = isCCA ? overlay.plans[planId] : plan.generation;
      b.generation += iv.kWh * priceAtHour(genTree[season][dayType], hour);
    }
  }

  const totalKWh = [...bySeason.values()].reduce((s, b) => s + b.kWh, 0);
  const days = allDays.size;

  // --- baseline allowance -------------------------------------------------
  // Allowance is per-day and season-specific, so it accrues day by day rather
  // than being a flat monthly number.
  const zone = utility.baseline?.climate_zones?.[climateZone];
  if (!zone) throw new Error(`Unknown climate zone "${climateZone}".`);
  const allowanceFor = (season, dayCount) => {
    const perDay = zone[baselineType]?.[`${season}_kwh_per_day`];
    if (perDay == null) throw new Error(`No ${baselineType} allowance for ${season}.`);
    return perDay * dayCount;
  };

  let baselineAllowanceKWh = 0;
  for (const [season, b] of bySeason) baselineAllowanceKWh += allowanceFor(season, b.days.size);

  // --- tiered pricing -----------------------------------------------------
  if (model === "tiered") {
    if (bySeason.size > 1) {
      notes.push(
        "The period spans both seasons. Tiers are applied per season using that season's own " +
          "days and usage, which is an approximation of a single period-wide tier boundary.",
      );
    }
    for (const [season, b] of bySeason) {
      const allowance = allowanceFor(season, b.days.size);
      b.delivery = applyTiers(plan.delivery[season], b.kWh, allowance);
      const genTiers = isCCA ? overlay.plans[planId][season] : plan.generation[season];
      b.generation = applyTiers(genTiers, b.kWh, allowance);
    }
  }

  const delivery = sum(bySeason, "delivery");
  let generation = sum(bySeason, "generation");

  // --- CCA generation credit ---------------------------------------------
  let generationCredit = 0;
  if (isCCA && typeof overlay.generation_credit_per_kwh === "number") {
    generationCredit = totalKWh * overlay.generation_credit_per_kwh;
    generation += generationCredit;
  }

  // --- fixed charges ------------------------------------------------------
  // A plan may override the file-level block; EV-TOU has no service charge but
  // does have a minimum bill.
  const fixedSpec = plan.fixed_charges ?? utility.fixed_charges;
  const fixed = (fixedSpec.daily_service_charge ?? 0) * days;

  // --- baseline adjustment credit ----------------------------------------
  // Applies to listed plans only, and only up to a percentage of baseline.
  // Tiered plans are excluded by design: DR's credit is already folded into
  // its tier-1 price, so applying it again would double-count.
  let baselineCredit = 0;
  const b = utility.baseline;
  if (b?.credit_applies_to_plans?.includes(planId)) {
    const cap = baselineAllowanceKWh * ((b.credit_applies_up_to_pct_of_baseline ?? 100) / 100);
    baselineCredit = Math.min(totalKWh, cap) * b.credit_per_kwh;
  }

  // --- CCA adders ---------------------------------------------------------
  // PCIA is vintaged by the year the customer left bundled service; the 2009
  // and 2024 vintages differ by more than 3x, so guessing is not an option.
  let pcia = 0;
  if (isCCA) {
    const vintage = pciaVintage ?? overlay.pcia_vintage ?? utility.cca_adders.pcia_vintage_used;
    const rate = utility.cca_adders.pcia_by_vintage?.[String(vintage)];
    if (rate == null) {
      throw new Error(`No PCIA rate for vintage ${vintage}.`);
    }
    pcia = totalKWh * rate;
    notes.push(`PCIA charged at the ${vintage} vintage ($${rate}/kWh).`);
  }

  // --- taxes and fees -----------------------------------------------------
  const tf = utility.taxes_and_fees ?? {};
  const stateRegulatoryFee = totalKWh * (tf.state_regulatory_fee_per_kwh ?? 0);

  const subtotal = delivery + fixed + generation + baselineCredit + pcia + stateRegulatoryFee;

  // Both fee bases were derived arithmetically from a single bill and reproduce
  // it to the cent, but neither is stated in any tariff. See rates/VALIDATION.md.
  let franchiseFeeDifferential = 0;
  if (inCityOfSanDiego && tf.franchise_fee_differential_pct) {
    const wfNbc = 0; // already folded into this file's delivery prices
    franchiseFeeDifferential =
      (subtotal - pcia - wfNbc) * (tf.franchise_fee_differential_pct / 100);
    warnings.push(
      "Franchise fee differential uses a base inferred from one bill, not published in any tariff.",
    );
  }

  let franchiseFeeEquivalent = 0;
  if (isCCA && tf.franchise_fee_equivalent_surcharge_pct) {
    // Charged on SDG&E's *imputed* generation — what the utility would have
    // billed had the customer stayed bundled — not on what the CCA charged.
    const imputed = imputedUtilityGeneration({ utility, plan, model, bySeason, calendar, intervals });
    const careSurcharge = totalKWh * (tf.care_surcharge_per_kwh ?? 0);
    franchiseFeeEquivalent =
      (imputed + careSurcharge) * (tf.franchise_fee_equivalent_surcharge_pct / 100);
    warnings.push(
      "Franchise fee equivalent surcharge uses a rate and base taken from one bill, not published in any tariff.",
    );
  }

  const total = subtotal + franchiseFeeDifferential + franchiseFeeEquivalent;

  // Minimum bill, where the plan has one.
  const minimumBill = (fixedSpec.minimum_bill_daily ?? 0) * days;
  const totalAfterMinimum = Math.max(total, minimumBill);
  if (totalAfterMinimum > total) {
    notes.push(`Minimum bill of $${minimumBill.toFixed(2)} applied.`);
  }

  return {
    planId,
    planName: plan.name,
    provider: isCCA ? (overlay.product ?? overlay.provider) : "SDG&E",
    pricingModel: model,
    days,
    totalKWh,
    baselineAllowanceKWh,
    lines: {
      delivery,
      fixed,
      generation,
      generationCredit,
      baselineCredit,
      pcia,
      stateRegulatoryFee,
      franchiseFeeDifferential,
      franchiseFeeEquivalent,
    },
    total: totalAfterMinimum,
    seasons: Object.fromEntries(
      [...bySeason].map(([name, s]) => [
        name,
        { kWh: s.kWh, days: s.days.size, delivery: s.delivery, generation: s.generation },
      ]),
    ),
    notes,
    warnings,
  };
}

/**
 * Price usage against a tier ladder.
 *
 * Thresholds are percentages of the baseline allowance, not flat kWh, so the
 * boundary moves with climate zone and period length.
 */
function applyTiers(tiers, kWh, allowanceKWh) {
  let remaining = kWh;
  let consumed = 0;
  let cost = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;
    const cap =
      tier.up_to_pct_of_baseline == null
        ? Infinity
        : allowanceKWh * (tier.up_to_pct_of_baseline / 100);
    const take = Math.min(remaining, Math.max(0, cap - consumed));
    cost += take * tier.price_per_kwh;
    consumed += take;
    remaining -= take;
  }
  return cost;
}

/**
 * What SDG&E's own generation would have cost for the same usage. A CCA bill
 * charges this and credits it back, so it nets to zero — but the franchise fee
 * equivalent is assessed on it, so it still has to be computed.
 */
function imputedUtilityGeneration({ utility, plan, model, bySeason, calendar, intervals }) {
  if (model === "tiered") {
    // Every CCA publishes a flat generation price for tiered plans, so the
    // allowance is irrelevant here — all usage lands in the first tier.
    let total = 0;
    for (const [season, b] of bySeason) {
      total += applyTiers(plan.generation[season], b.kWh, Infinity);
    }
    return total;
  }
  let total = 0;
  for (const iv of intervals) {
    const season = calendar.seasonOf(iv.start);
    const dayType = calendar.dayTypeOf(iv.start);
    total += iv.kWh * priceAtHour(plan.generation[season][dayType], iv.start.getHours());
  }
  return total;
}

const sum = (map, key) => [...map.values()].reduce((s, b) => s + b[key], 0);

/**
 * Cost every plan a provider serves and rank by total.
 * Plans the overlay doesn't carry are skipped rather than silently mispriced.
 */
export function rankPlans(opts) {
  const results = [];
  for (const plan of opts.utility.plans) {
    if (opts.overlay && !opts.overlay.plans[plan.id]) continue;
    try {
      results.push(costPlan({ ...opts, planId: plan.id }));
    } catch (e) {
      results.push({ planId: plan.id, planName: plan.name, error: e.message });
    }
  }
  return results.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
}
