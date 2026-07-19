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
import { createExportPricer, nemEligiblePlans, settleMonthlyCredits } from "./nem.js";

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
 * @param {object}  [o.nem]        solar: {mode, vintage, exportTable, adderPerKWh}
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
  nem = null,
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

  // --- solar --------------------------------------------------------------
  const nemMode = nem?.mode ?? "none";
  const hasSolar = intervals.some((iv) => iv.generationKWh > 0);

  if (nemMode !== "none" && !hasSolar) {
    warnings.push(
      "A net metering plan is selected but this file contains no exported energy. Either the export " +
        "carries no solar data or the account has no solar — the result below is not a solar bill.",
    );
  }

  // Non-bypassable charges survive netting under NEM 2.0, so they have to be
  // separable from the delivery price. Without them the plan simply cannot be
  // costed on that path rather than being costed wrongly.
  const nbcRate = plan.nonbypassable_charges?.total_per_kwh;
  if (nemMode === "nem2" && typeof nbcRate !== "number") {
    throw new Error(
      `Plan "${planId}" has no nonbypassable_charges block, which NEM 2.0 needs to bill charges that ` +
        `exports cannot net away.`,
    );
  }

  let exportPricer = null;
  if (nemMode === "nem3") {
    exportPricer = createExportPricer({
      exportTable: nem.exportTable,
      vintage: nem.vintage,
      adderPerKWh: isCCA ? (overlay.nbt_generation_adder_per_kwh ?? 0) : 0,
      calendar,
    });
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

  // Per-month energy dollars, so credits can be seen to carry rather than being
  // paid out at the end of each month.
  const byMonth = new Map();
  const monthBucket = (date) => {
    const key = monthKey(date);
    if (!byMonth.has(key)) byMonth.set(key, { energy: 0, days: new Set() });
    return byMonth.get(key);
  };

  const allDays = new Set();
  let grossImportKWh = 0;
  let exportedKWh = 0;
  let nbcBaseKWh = 0;
  let exportCredit = 0;

  // NEM 2.0 nets per TOU period per billing month, not per interval and not
  // across the whole period — Schedule NEM-ST SC 3(b). The distinction is worth
  // real money: a month that exports heavily at super-off-peak and imports at
  // on-peak nets to a negative total, but the on-peak period is still billed in
  // full. Summing signed intervals would let the export cancel it.
  //
  // A TOU period is identified by its generation price within a season, which is
  // what actually distinguishes on/off/super-off-peak — the rate file names its
  // hour blocks nowhere, and delivery is a single flat block on some schedules
  // even where the bill still splits it three ways.
  const touBuckets = new Map();
  const touBucket = (month, season, genPrice) => {
    const key = `${month}|${season}|${genPrice}`;
    if (!touBuckets.has(key)) {
      touBuckets.set(key, { month, season, net: 0, deliveryPrice: 0, genPrice, utilGenPrice: 0 });
    }
    return touBuckets.get(key);
  };
  let imputedNem2 = 0;

  for (const iv of intervals) {
    const season = calendar.seasonOf(iv.start);
    const dayType = calendar.dayTypeOf(iv.start);
    const hour = iv.start.getHours();
    const b = bucket(season);
    const m = monthBucket(iv.start);
    const dayKey = localDateKey(iv.start);

    const imported = iv.kWh;
    const exported = nemMode === "none" ? 0 : (iv.generationKWh ?? 0);
    // NEM 2.0 nets at the meter; NEM 3.0 bills imports gross and prices exports
    // on their own table. The signed value is what energy is charged on.
    const billed = nemMode === "nem2" ? imported - exported : imported;

    grossImportKWh += imported;
    exportedKWh += exported;
    if (nemMode === "nem2") nbcBaseKWh += Math.max(0, imported - exported);

    b.kWh += billed;
    b.days.add(dayKey);
    m.days.add(dayKey);
    allDays.add(dayKey);

    if (model === "tou") {
      // Under NEM 2.0 the non-bypassable component is stripped out of the price
      // being netted against and billed separately below, so exports cannot
      // cancel it. Everything else nets at retail.
      const deliveryPrice =
        priceAtHour(plan.delivery[season][dayType], hour) - (nemMode === "nem2" ? nbcRate : 0);
      const genTree = isCCA ? overlay.plans[planId] : plan.generation;
      const generationPrice = priceAtHour(genTree[season][dayType], hour);

      if (nemMode === "nem2") {
        // Accumulate now, price once the month's TOU periods are known.
        const t = touBucket(monthKey(iv.start), season, generationPrice);
        t.net += billed;
        t.deliveryPrice = deliveryPrice;
        t.utilGenPrice = priceAtHour(plan.generation[season][dayType], hour);
      } else {
        const deliveryCost = billed * deliveryPrice;
        const generationCost = billed * generationPrice;
        b.delivery += deliveryCost;
        b.generation += generationCost;
        m.energy += deliveryCost + generationCost;
      }
    }

    if (exportPricer && exported > 0) {
      const credit = exported * exportPricer.priceAt(iv.start);
      exportCredit += credit;
      m.energy -= credit;
    }
  }

  // Price the NEM 2.0 TOU buckets now that each month's periods are complete.
  //
  // Delivery floors at zero per period; generation does not. That asymmetry is
  // what a real bill shows: a period that nets negative prints "$.00000" on the
  // delivery line, while the CCA credits the same negative period at its full
  // generation rate. The delivery-side value of those exports is not lost — it
  // accrues to the NEM credit bank and comes back as an applied credit — but it
  // does not reduce delivery within the month.
  let positiveNetKWh = 0;
  if (nemMode === "nem2") {
    for (const t of touBuckets.values()) {
      const b = bucket(t.season);
      const m = byMonth.get(t.month);
      const billableNet = Math.max(0, t.net);
      positiveNetKWh += billableNet;

      const deliveryCost = billableNet * t.deliveryPrice;
      const generationCost = t.net * t.genPrice;
      b.delivery += deliveryCost;
      b.generation += generationCost;
      if (m) m.energy += deliveryCost + generationCost;

      // SDG&E's imputed generation floors the same way its delivery does — it
      // is the utility's own line, not the CCA's.
      imputedNem2 += billableNet * t.utilGenPrice;
    }
  }

  if (exportPricer) warnings.push(...exportPricer.warnings);

  // Net consumption for a NEM 2.0 customer, gross import otherwise. This is the
  // figure tiers, the baseline allowance and the baseline credit work against —
  // NEM-ST SC 3(a) prices net kWh at baseline rates.
  const totalKWh = [...bySeason.values()].reduce((s, b) => s + b.kWh, 0);
  const days = allDays.size;

  // Two different bases, and a real bill uses both — mixing them up is a 3x
  // error on the PCIA line:
  //
  //   Non-bypassable charges  -> import net of exports in each *interval*,
  //                              floored at zero (NEM-ST SC 1). Larger.
  //   PCIA, state fee, CARE   -> net of exports per *TOU period per month*,
  //                              floored at zero. Smaller.
  //
  // On the validated bill these were 497 kWh and 156 kWh for the same month.
  const adderBaseKWh = nemMode === "nem2" ? positiveNetKWh : grossImportKWh;

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
      // A season that nets negative has no tiers to climb. Tiered plans are not
      // NEM-eligible anyway, so this only guards against being called directly.
      const tiered = Math.max(0, b.kWh);
      b.delivery = applyTiers(plan.delivery[season], tiered, allowance);
      const genTiers = isCCA ? overlay.plans[planId][season] : plan.generation[season];
      b.generation = applyTiers(genTiers, tiered, allowance);
    }
    // byMonth is left empty here on purpose: it only feeds the credit
    // carryforward, and tiered plans are not eligible for either NEM tariff.
  }

  const delivery = sum(bySeason, "delivery");
  let generation = sum(bySeason, "generation");

  // --- CCA generation credit ---------------------------------------------
  let generationCredit = 0;
  if (isCCA && typeof overlay.generation_credit_per_kwh === "number") {
    generationCredit = adderBaseKWh * overlay.generation_credit_per_kwh;
    generation += generationCredit;
  }

  // --- non-bypassable charges ---------------------------------------------
  // Stripped out of the netted delivery price above and billed here on import
  // instead, so a household that exports as much as it imports still pays them.
  // This is the single largest reason a net-zero solar bill is not a zero bill.
  const nonbypassable = nemMode === "nem2" ? nbcBaseKWh * nbcRate : 0;

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
    // Against billable net consumption. Under NEM 2.0 that is the same
    // positive-TOU-period figure the other volumetric lines use, not the signed
    // total — a net generator would otherwise earn a negative credit.
    //
    // UNVERIFIED: the validated bill applied this to 144 kWh in a month whose
    // positive TOU net was 156 kWh. The 12 kWh gap is unexplained and no
    // candidate base reproduces it, so this line is expected to run ~8% high for
    // solar customers. See README "Needs verifying".
    const creditBase = nemMode === "nem2" ? positiveNetKWh : Math.max(totalKWh, 0);
    baselineCredit = Math.min(creditBase, cap) * b.credit_per_kwh;
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
    pcia = adderBaseKWh * rate;
    notes.push(`PCIA charged at the ${vintage} vintage ($${rate}/kWh).`);
  }

  // --- taxes and fees -----------------------------------------------------
  const tf = utility.taxes_and_fees ?? {};
  const stateRegulatoryFee = adderBaseKWh * (tf.state_regulatory_fee_per_kwh ?? 0);

  const subtotal =
    delivery + fixed + generation + baselineCredit + pcia + stateRegulatoryFee +
    nonbypassable - exportCredit;

  // Both fee bases were derived arithmetically from a single bill and reproduce
  // it to the cent, but neither is stated in any tariff. See rates/VALIDATION.md.
  let franchiseFeeDifferential = 0;
  if (inCityOfSanDiego && tf.franchise_fee_differential_pct) {
    // The base is SDG&E's own Total Electric Charges, less PCIA and WF-NBC.
    // Two things are therefore *not* in it:
    //
    //  - CCA generation. A CCA bills the commodity itself, in its own section
    //    below SDG&E's total. Leaving it in made the base swing negative for any
    //    exporter, since the generation line is a large credit.
    //  - The wildfire fund charge. On the NEM 2.0 path it is billed separately
    //    inside `nonbypassable`, so it has to come back out here; on the
    //    non-NEM path it is folded into the delivery price instead, and is
    //    subtracted at the same per-kWh rate off the same gross usage.
    //
    // Checked against the net-exporter bill: $24.60 fixed + $7.12 NBC net of
    // wildfire = $31.72, x 5.78% = $1.83, the figure printed.
    const wfNbcRate = plan.nonbypassable_charges?.wf_nbc_per_kwh ?? 0;
    const wfNbc = (nemMode === "nem2" ? nbcBaseKWh : grossImportKWh) * wfNbcRate;
    const utilityCharges = subtotal - (isCCA ? generation : 0);
    franchiseFeeDifferential =
      (utilityCharges - pcia - wfNbc) * (tf.franchise_fee_differential_pct / 100);
    warnings.push(
      "Franchise fee differential uses a base inferred from one bill, not published in any tariff.",
    );
  }

  // A city's total franchise fee is the 1.1% base plus its differential, and
  // only the City of San Diego has one (5.78%, so 6.88% in total). CCA customers
  // pay that total as an equivalent surcharge on imputed generation, because
  // SDG&E never bills them for the commodity itself.
  const franchiseFeeTotalPct =
    (tf.franchise_fee_base_pct ?? 0) +
    (inCityOfSanDiego ? (tf.franchise_fee_differential_pct ?? 0) : 0);

  let franchiseFeeEquivalent = 0;
  if (isCCA && franchiseFeeTotalPct) {
    // Charged on SDG&E's *imputed* generation — what the utility would have
    // billed had the customer stayed bundled — not on what the CCA charged.
    const imputed = nemMode === "nem2"
      ? imputedNem2
      : imputedUtilityGeneration({ utility, plan, model, bySeason, calendar, intervals, nemMode });
    const careSurcharge = adderBaseKWh * (tf.care_surcharge_per_kwh ?? 0);
    franchiseFeeEquivalent = (imputed + careSurcharge) * (franchiseFeeTotalPct / 100);
    warnings.push(
      "Franchise fee equivalent surcharge is charged on a base inferred from a bill, not published in any tariff.",
    );
  }

  let total = subtotal + franchiseFeeDifferential + franchiseFeeEquivalent;

  // --- solar settlement ---------------------------------------------------
  // Credits carry month to month, but a customer left holding credit at the end
  // of the period is not paid it in cash. They get Net Surplus Compensation at a
  // wholesale rate that is DLAP-indexed for SDG&E and CAISO-indexed for SDCP,
  // varies hourly, and is not modelled — so the bill floors at zero and the
  // leftover is reported instead of being booked as a negative total.
  let unusedCredit = 0;
  let monthsInCredit = 0;
  if (nemMode !== "none") {
    ({ unusedCredit, monthsInCredit } = settleMonthlyCredits(byMonth));
    // Generation credits cannot reach the Base Services Charge or the
    // non-bypassable charges. A net exporter's bill is exactly those two lines,
    // and SDG&E's own Net Energy Metering Summary says so: it prints the whole
    // remaining balance under the heading "Non-Bypassable Charges".
    //
    // Checked against a net-exporter bill: 31 days, -831 kWh, 472 kWh of NBC
    // usage. $24.60 Base Services + $7.12 NBC + $2.79 Wildfire Fund = $34.51,
    // and the franchise fees below it ($1.83 + $0.19) were cancelled to the cent
    // by an Applied Generation Credit — so fees are offsettable and these two
    // are not. Flooring at `fixed` alone under-billed that account by $9.91.
    const nonOffsettable = fixed + nonbypassable;
    const offsettable = total - nonOffsettable;
    if (offsettable < 0) {
      unusedCredit = Math.max(unusedCredit, -offsettable);
      total = nonOffsettable;
    }
    if (unusedCredit > 0) {
      notes.push(
        `Ends the period with $${unusedCredit.toFixed(2)} of unused credit. At annual true-up that is ` +
          `paid as Net Surplus Compensation at a wholesale rate this calculator does not model, so the ` +
          `real total is a little lower than shown.`,
      );
    }
    if (monthsInCredit > 0) {
      notes.push(`${monthsInCredit} month(s) generated more value than they consumed.`);
    }
  }

  // Minimum bill, where the plan has one — only EV-TOU still does. Every other
  // residential schedule replaced it with the Base Services Charge above.
  //
  // KNOWN WRONG, deliberately: the tariff applies this per billing cycle, and
  // this compares it against the whole period, so a light month cannot be
  // rescued by the heavy month beside it. Fixing it needs per-month charge
  // totals, which the season-bucketed accumulation above does not carry. It
  // only ever bites on EV-TOU, which is separately metered and already unsafe
  // to rank against a whole-home export.
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
    nemMode,
    days,
    totalKWh,
    grossImportKWh,
    exportedKWh,
    unusedCredit,
    monthsInCredit,
    baselineAllowanceKWh,
    lines: {
      delivery,
      fixed,
      generation,
      generationCredit,
      baselineCredit,
      pcia,
      stateRegulatoryFee,
      nonbypassable,
      exportCredit,
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
function imputedUtilityGeneration({ utility, plan, model, bySeason, calendar, intervals, nemMode }) {
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
    // Same import/net treatment as the real generation line. Imputing against
    // gross usage for a solar customer would charge the CCA franchise fee on
    // energy the customer never bought.
    const billed = nemMode === "nem2" ? iv.kWh - (iv.generationKWh ?? 0) : iv.kWh;
    total += billed * priceAtHour(plan.generation[season][dayType], iv.start.getHours());
  }
  return total;
}

const sum = (map, key) => [...map.values()].reduce((s, b) => s + b[key], 0);

/** Calendar month as a sortable key. Used as a stand-in for the billing month. */
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/**
 * Cost every plan a provider serves and rank by total.
 *
 * Plans the overlay doesn't carry are skipped rather than silently mispriced,
 * and under a NEM tariff the plans that tariff forbids are dropped with a
 * reason. Returns those reasons alongside the results so the caller can explain
 * a short list instead of just showing one.
 */
export function rankPlans(opts) {
  const { allowed, excluded } = nemEligiblePlans(opts.nem?.mode ?? "none", opts.utility.plans);
  const results = [];

  for (const plan of allowed) {
    if (opts.overlay && !opts.overlay.plans[plan.id]) continue;
    try {
      results.push(costPlan({ ...opts, planId: plan.id }));
    } catch (e) {
      results.push({ planId: plan.id, planName: plan.name, error: e.message });
    }
  }

  results.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
  results.excluded = excluded;
  return results;
}
