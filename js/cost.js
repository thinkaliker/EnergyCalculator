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
import { revisionProvenance } from "./revisions.js";

/**
 * The price for a clock hour, on a given calendar month.
 *
 * The month matters because a TOU window can be scoped to part of a season.
 * EV-TOU-5 and TOU-DR1 both price 10am–2pm as super-off-peak **in March and
 * April only**, and as off-peak for the rest of winter — the bill's own TOU
 * chart says so outright: "Off-Peak: 6:00 a.m. – 4:00 p.m. Excluding 10:00 a.m.
 * – 2:00 p.m. in March and April". Treating that window as super-off-peak all
 * winter, which this file did until now, misprices every November-to-February
 * midday hour by roughly 0.29 $/kWh.
 *
 * A block with no `months` applies to its whole season, which is the common
 * case and every block written before this rule existed. Month-scoped blocks
 * are searched first so the narrower rule wins over the broader one it carves
 * out of — that is what lets the two overlap in the file and stay readable,
 * rather than forcing the season to be split into four disjoint ranges.
 *
 * @param {number} month 1-12
 */
const priceAtHour = (blocks, hour, month) => {
  const covers = (x) => hour >= x.start_hour && hour < x.end_hour;
  const b =
    blocks.find((x) => x.months?.includes(month) && covers(x)) ??
    blocks.find((x) => !x.months && covers(x));
  if (!b) throw new Error(`No price covers hour ${hour} in month ${month} — rate file has an hour gap.`);
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
 * @param {number}  [o.billingCycleDay] meter-read day, from the true-up date;
 *                  omit for calendar months
 * @param {string[]} [o.trueUpBoundaries] billing-month keys that end a Relevant
 *                  Period, at which carried credit is forfeited
 * @param {object}  [o.history] timeline from revisions.js buildHistory; omit to
 *                  price the whole series at `utility` and `overlay` as given
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
  billingCycleDay = null,
  trueUpBoundaries = [],
  history = null,
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

  // --- which revision priced a given day ----------------------------------
  //
  // Rates change three or four times a year and a billing period can span a
  // change, so the prices in force are a function of the day, not of the run.
  // Everything below reads its rates through `revAt` rather than closing over
  // `plan` and `overlay` directly.
  //
  // With no history this returns one frozen object, by identity, every time.
  // That is deliberate: "no archive" must not be a different code path from
  // "an archive", or the reference bills that already reconcile would drift.
  const currentRev = {
    id: utility.effective_date,
    utility,
    plan,
    overlay,
    overlayPlan: isCCA ? overlay.plans[planId] : null,
    nbcRate,
  };
  const revById = new Map([[currentRev.id, currentRev]]);

  // Which utility revisions actually priced something. Not the same as which
  // ones exist: a period may sit entirely inside one, and the UI should say so
  // rather than listing an archive the answer does not depend on.
  const usedRevisionIds = new Set(history ? [] : [currentRev.id]);

  const revAt = history
    ? (date) => {
        const u = history.utilityAt(date);
        const o = history.overlayAt ? history.overlayAt(date) : null;
        const id = `${u.id}${o ? `|${o.id}` : ""}`;
        usedRevisionIds.add(u.id);
        if (revById.has(id)) return revById.get(id);

        // A backfilled revision may predate a schedule, or simply not have been
        // extracted yet. Falling back to the current plan keeps a partly-filled
        // archive usable — the same policy revisions.js applies to whole files,
        // applied one level down.
        const histPlan = u.doc.plans?.find((p) => p.id === planId);
        if (!histPlan) {
          warnings.push(
            `The ${u.id} rates have no plan "${planId}", so those days are priced at the ` +
              `${currentRev.id} revision.`,
          );
        }
        const histOverlayPlan = isCCA ? o?.doc.plans?.[planId] : null;
        if (isCCA && o && !histOverlayPlan) {
          warnings.push(
            `${o.doc.product ?? o.doc.provider} did not publish plan "${planId}" in its ${o.id} ` +
              `rates, so those days use the current generation prices.`,
          );
        }

        const resolved = {
          id,
          utility: u.doc,
          plan: histPlan ?? plan,
          overlay: o?.doc ?? overlay,
          overlayPlan: isCCA ? (histOverlayPlan ?? overlay.plans[planId]) : null,
          nbcRate: (histPlan ?? plan).nonbypassable_charges?.total_per_kwh ?? nbcRate,
        };
        revById.set(id, resolved);
        return resolved;
      }
    : () => currentRev;

  if (history) warnings.push(...history.warnings);

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

  // Tiered plans need the same split again by revision, because a tier price
  // moves with the revision and the allowance those tiers are measured against
  // is per-day. Filled unconditionally; read only on the tiered path.
  const bySeasonRev = new Map();
  const seasonRevBucket = (season, revId) => {
    const key = `${season}|${revId}`;
    if (!bySeasonRev.has(key)) {
      bySeasonRev.set(key, { season, revId, kWh: 0, days: new Set() });
    }
    return bySeasonRev.get(key);
  };

  // Per-month energy dollars, so credits can be seen to carry rather than being
  // paid out at the end of each month, plus raw net kWh — which is a separate
  // quantity from the dollars and not derivable from them. Schedule NEM-ST
  // SC 3(h) settles net surplus on kWh alone, so the true-up needs this
  // un-TOU-weighted figure alongside the priced one.
  const byMonth = new Map();
  const monthBucket = (date) => {
    const key = billingMonthKey(date, billingCycleDay);
    if (!byMonth.has(key)) byMonth.set(key, { energy: 0, netKWh: 0, days: new Set() });
    return byMonth.get(key);
  };

  const allDays = new Set();
  let grossImportKWh = 0;
  let exportedKWh = 0;
  let nbcBaseKWh = 0;
  let exportCredit = 0;

  // Volumetric charges that are not delivery or generation — PCIA, the state
  // regulatory fee, the CARE surcharge, the non-bypassable total — are a rate
  // times a kWh base, and the rate moves with the revision. So the base has to
  // be split the same way rather than accumulated as one number.
  //
  // Which day each kWh landed in is also which revision priced it, so these two
  // maps are filled in the same pass that prices energy.
  const kWhByRev = new Map();
  const nbcByRev = new Map();
  const addTo = (map, id, kWh) => map.set(id, (map.get(id) ?? 0) + kWh);
  // Days are the base for the fixed charge, which is per-day and also moves
  // with the revision — 4 days at one Base Services Charge and 25 at another.
  const daysByRev = new Map();
  const dayRev = new Map();

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
  //
  // The revision is part of the key as well. A rate change starts a new charge
  // block on the bill, so the periods either side of it are separate periods.
  // The generation price alone very nearly does this by accident, since a
  // revision moves it — but `deliveryPrice` is stored on the bucket rather than
  // keyed, so two revisions that happened to share a generation price would
  // collide and the last interval seen would silently set the delivery rate for
  // all of them.
  const touBuckets = new Map();
  const touBucket = (month, season, genPrice, revId) => {
    const key = `${month}|${season}|${genPrice}|${revId}`;
    if (!touBuckets.has(key)) {
      touBuckets.set(key, { month, season, revId, net: 0, deliveryPrice: 0, genPrice, utilGenPrice: 0 });
    }
    return touBuckets.get(key);
  };
  let imputedNem2 = 0;

  for (const iv of intervals) {
    const season = calendar.seasonOf(iv.start);
    const dayType = calendar.dayTypeOf(iv.start);
    const hour = iv.start.getHours();
    const month = iv.start.getMonth() + 1;
    const b = bucket(season);
    const m = monthBucket(iv.start);
    const dayKey = localDateKey(iv.start);
    const rev = revAt(iv.start);
    dayRev.set(dayKey, rev);

    const imported = iv.kWh;
    const exported = nemMode === "none" ? 0 : (iv.generationKWh ?? 0);
    // NEM 2.0 nets at the meter; NEM 3.0 bills imports gross and prices exports
    // on their own table. The signed value is what energy is charged on.
    const billed = nemMode === "nem2" ? imported - exported : imported;

    grossImportKWh += imported;
    exportedKWh += exported;
    addTo(kWhByRev, rev.id, imported);
    if (nemMode === "nem2") {
      const net = Math.max(0, imported - exported);
      nbcBaseKWh += net;
      addTo(nbcByRev, rev.id, net);
    }

    b.kWh += billed;
    b.days.add(dayKey);
    const sr = seasonRevBucket(season, rev.id);
    sr.kWh += billed;
    sr.days.add(dayKey);
    m.days.add(dayKey);
    m.netKWh += imported - exported;
    allDays.add(dayKey);

    if (model === "tou") {
      // Under NEM 2.0 the non-bypassable component is stripped out of the price
      // being netted against and billed separately below, so exports cannot
      // cancel it. Everything else nets at retail.
      const deliveryPrice =
        priceAtHour(rev.plan.delivery[season][dayType], hour, month) - (nemMode === "nem2" ? rev.nbcRate : 0);
      const genTree = isCCA ? rev.overlayPlan : rev.plan.generation;
      const generationPrice = priceAtHour(genTree[season][dayType], hour, month);

      if (nemMode === "nem2") {
        // Accumulate now, price once the month's TOU periods are known.
        const t = touBucket(billingMonthKey(iv.start, billingCycleDay), season, generationPrice, rev.id);
        t.net += billed;
        t.deliveryPrice = deliveryPrice;
        t.utilGenPrice = priceAtHour(rev.plan.generation[season][dayType], hour, month);
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
  const positiveNetByRev = new Map();
  if (nemMode === "nem2") {
    for (const t of touBuckets.values()) {
      const b = bucket(t.season);
      const m = byMonth.get(t.month);
      const billableNet = Math.max(0, t.net);
      positiveNetKWh += billableNet;
      addTo(positiveNetByRev, t.revId, billableNet);

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
  const adderBaseByRev = nemMode === "nem2" ? positiveNetByRev : kWhByRev;

  /**
   * A volumetric charge, priced at each revision's own rate.
   *
   * `pick` is given the revision's utility document and returns the rate, so a
   * caller reads as the tariff line it is charging. With no history there is one
   * entry and this reduces to the multiplication it replaced.
   */
  const perRev = (base, pick) => {
    let total = 0;
    for (const [id, kWh] of base) total += kWh * (pick(revById.get(id)) ?? 0);
    return total;
  };

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
    if (history && bySeasonRev.size > bySeason.size) {
      notes.push(
        "A rate revision falls inside this period. Tiers are applied to each side of it " +
          "separately, with the baseline allowance prorated by the days on each side — which " +
          "is how the bill splits it.",
      );
    }
    for (const b of bySeason.values()) {
      b.delivery = 0;
      b.generation = 0;
    }
    for (const sr of bySeasonRev.values()) {
      const b = bucket(sr.season);
      const rev = revById.get(sr.revId);
      // Prorated: the allowance accrues per day, so a segment earns the days it
      // actually contains and no more. Splitting a period at a revision without
      // splitting the allowance with it would hand each segment a full period's
      // worth and price nearly everything at tier 1.
      const allowance = allowanceFor(sr.season, sr.days.size);
      // A season that nets negative has no tiers to climb. Tiered plans are not
      // NEM-eligible anyway, so this only guards against being called directly.
      const tiered = Math.max(0, sr.kWh);
      b.delivery += applyTiers(rev.plan.delivery[sr.season], tiered, allowance);
      const genTiers = isCCA ? rev.overlayPlan[sr.season] : rev.plan.generation[sr.season];
      b.generation += applyTiers(genTiers, tiered, allowance);
    }
    // byMonth is left empty here on purpose: it only feeds the credit
    // carryforward, and tiered plans are not eligible for either NEM tariff.
  }

  const delivery = sum(bySeason, "delivery");
  let generation = sum(bySeason, "generation");

  // --- CCA generation credit ---------------------------------------------
  let generationCredit = 0;
  if (isCCA && typeof overlay.generation_credit_per_kwh === "number") {
    // A temporary credit that lapses: it is in one revision's overlay and not
    // the next, which is exactly why it is stored separately from the prices.
    generationCredit = perRev(adderBaseByRev, (r) => r.overlay?.generation_credit_per_kwh);
    generation += generationCredit;
  }

  // --- non-bypassable charges ---------------------------------------------
  // Stripped out of the netted delivery price above and billed here on import
  // instead, so a household that exports as much as it imports still pays them.
  // This is the single largest reason a net-zero solar bill is not a zero bill.
  const nonbypassable =
    nemMode === "nem2" ? perRev(nbcByRev, (r) => r.nbcRate) : 0;

  // --- fixed charges ------------------------------------------------------
  // A plan may override the file-level block; EV-TOU has no service charge but
  // does have a minimum bill.
  //
  // Charged per day at that day's own rate, which is what the bill prints when a
  // revision lands mid-period: 4 days at one Base Services Charge and 25 at the
  // next. `dayRev` was filled during the interval pass, so this is a lookup.
  const fixedSpecFor = (r) => r.plan.fixed_charges ?? r.utility.fixed_charges;
  let fixed = 0;
  let minimumBill = 0;
  for (const dayKey of allDays) {
    const spec = fixedSpecFor(dayRev.get(dayKey) ?? currentRev);
    fixed += spec.daily_service_charge ?? 0;
    // EV-TOU has no service charge but does have a minimum bill, and it is the
    // same kind of quantity — a daily rate that a revision can move.
    minimumBill += spec.minimum_bill_daily ?? 0;
  }

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
    const credited = Math.min(creditBase, cap);
    // `creditBase` is the same quantity `adderBaseByRev` splits — net-of-export
    // in TOU periods under NEM 2.0, gross import otherwise — so the cap can be
    // applied period-wide and then shared out in proportion. The share is 1 in
    // the common case where the cap does not bind, and every revision is
    // credited at its own rate either way.
    const share = creditBase > 0 ? credited / creditBase : 0;
    baselineCredit = share * perRev(adderBaseByRev, (r) => r.utility.baseline?.credit_per_kwh);
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
    // The vintage is a property of the customer and does not move; the rate
    // charged for it does, so it is looked up per revision.
    pcia = perRev(adderBaseByRev, (r) => r.utility.cca_adders?.pcia_by_vintage?.[String(vintage)] ?? rate);
    notes.push(`PCIA charged at the ${vintage} vintage ($${rate}/kWh).`);
  }

  // --- taxes and fees -----------------------------------------------------
  const tf = utility.taxes_and_fees ?? {};
  const stateRegulatoryFee = perRev(adderBaseByRev, (r) => r.utility.taxes_and_fees?.state_regulatory_fee_per_kwh);

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
    //    below SDG&E's total, and Schedule NEM-ST SC 3(c) requires it stay
    //    there: "The charges or credits resulting from a CCA's generation
    //    services shall not be co-mingled with charges or credits resulting
    //    from services provided by the Utility." Leaving it in made the base
    //    swing negative for any exporter, since generation is a large credit.
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
    const careSurcharge = perRev(adderBaseByRev, (r) => r.utility.taxes_and_fees?.care_surcharge_per_kwh);
    franchiseFeeEquivalent = (imputed + careSurcharge) * (franchiseFeeTotalPct / 100);
    warnings.push(
      "Franchise fee equivalent surcharge is charged on a base inferred from a bill, not published in any tariff.",
    );
  }

  let total = subtotal + franchiseFeeDifferential + franchiseFeeEquivalent;

  // --- solar settlement ---------------------------------------------------
  // Credits carry month to month, and stop carrying at the true-up date, where
  // Schedule NEM-ST SC 3 hands whatever is left to the utility. A net producer
  // is compensated instead under SC 3(h) — but on surplus *kWh*, not on this
  // dollar balance, and at a rate this calculator does not model. So the bill
  // floors and the leftover is reported rather than booked as a negative total.
  let unusedCredit = 0;
  let monthsInCredit = 0;
  let forfeitedCredit = 0;
  let ledger = [];
  if (nemMode !== "none") {
    ({ unusedCredit, monthsInCredit, forfeitedCredit, ledger } = settleMonthlyCredits(byMonth, {
      periodBoundaries: trueUpBoundaries,
    }));
    // Generation credits cannot reach the Base Services Charge or the
    // non-bypassable charges. Schedule NEM-ST SC 3 states it outright:
    // nonbypassable charges "shall be billed based on the kWhs consumed in each
    // metered interval net of exports, over the course of the 12-month period
    // and cannot be offset by generation credits" — and, for an exporter, "the
    // customer-generator shall still be responsible for payment of the
    // nonbypassable charges ... and no payment shall be made for the excess
    // energy delivered to the grid".
    //
    // Confirmed on a net-exporter bill: 31 days, -831 kWh, 472 kWh of NBC
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
        `Ends the period holding $${unusedCredit.toFixed(2)} of credit. It is not paid out — at the ` +
          `true-up date the utility keeps it. Any compensation depends instead on whether the year ` +
          `exported more kWh than it imported.`,
      );
    }
    if (forfeitedCredit > 0) {
      notes.push(
        `$${forfeitedCredit.toFixed(2)} of credit was forfeited at a true-up date inside this period.`,
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
    forfeitedCredit,
    // Per-billing-month rows mirroring the bill's NEM summary columns. Empty
    // for a non-solar plan, which has no credit balance to track.
    ledger,
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
    // Which archived rate revisions this figure rests on, and whether a person
    // has checked them. Empty when no archive was consulted.
    provenance: revisionProvenance(history, usedRevisionIds),
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
    total += billed * priceAtHour(plan.generation[season][dayType], iv.start.getHours(), iv.start.getMonth() + 1);
  }
  return total;
}

const sum = (map, key) => [...map.values()].reduce((s, b) => s + b[key], 0);

/** Calendar month as a sortable key. */
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/**
 * The billing month a moment falls in, as a sortable key.
 *
 * A real billing period runs meter-read to meter-read, not calendar month to
 * calendar month — the reference bill covers 5/30 to 6/29. Given the cycle's
 * anniversary day, a date on or after that day belongs to the period the key
 * names, and a date before it belongs to the previous one. So with day 30, both
 * 5/30 and 6/29 key to "2026-05", matching the bill.
 *
 * Without a cycle day this is the calendar month, which is what every caller
 * that has no true-up date gets. It is a stand-in, but an unbiased one: it
 * shifts which month a few days' energy lands in, never the period total.
 */
const billingMonthKey = (d, cycleDay) => {
  if (!cycleDay) return monthKey(d);
  if (d.getDate() >= cycleDay) return monthKey(d);
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return monthKey(prev);
};

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
