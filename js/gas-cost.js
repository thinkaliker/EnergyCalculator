// Residential natural gas billing (SDG&E Schedule GR). See rates/sdge-gas.json
// for the rate shape and its provenance.
//
// Deliberately separate from cost.js. Gas has no time-of-use, no NEM, no plan
// choice, and no hourly interval data — a bill is two flat per-therm rates
// applied against a seasonal baseline allowance, floored at a per-day minimum.
// Threading any of that through costPlan would mean a dozen kWh-shaped
// parameters gas has no use for, and pricing a $/therm number behind fields
// named for kWh.
//
// Pure and DOM-free, so tools/test.mjs can check it in Node.

/** Days in a calendar month. `year` matters only for February. `month` is 0-11. */
export function daysInCalendarMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Spread an annual therms total across 12 calendar months by a normalized
 * monthly_shape (fractions summing to 1). The gas analogue of period.js's
 * applyLoadProfile monthly branch, but it returns twelve monthly totals rather
 * than touching interval data — gas has no intervals.
 */
export function distributeTherms(annualTherms, monthlyShape) {
  if (!Array.isArray(monthlyShape) || monthlyShape.length !== 12) {
    throw new Error("monthly_shape must have 12 values");
  }
  return monthlyShape.map((f) => f * annualTherms);
}

/**
 * Month (0-11) -> its baseline allowance in therms/day, built from the gas
 * file's baseline_periods. Those periods partition the twelve months (the
 * validator enforces it), so every month resolves to exactly one allowance.
 */
function allowanceByMonth(gasUtility) {
  const out = new Array(12).fill(0);
  for (const [name, p] of Object.entries(gasUtility.baseline_periods)) {
    if (name.startsWith("_")) continue; // `_source` and friends are annotations
    for (const m of p.months) out[m - 1] = p.allowance_therms_per_day;
  }
  return out;
}

/**
 * Cost a year of gas usage.
 *
 * @param {object}   o.gasUtility    parsed rates/sdge-gas.json
 * @param {number[]} o.monthlyTherms 12 values, Jan..Dec, every end use summed
 * @param {number}   [o.year=2025]   affects only February's day count
 * @returns {{ total: number, lines: object, monthly: number[] }}
 */
export function costGasYear({ gasUtility, monthlyTherms, year = 2025 }) {
  if (!Array.isArray(monthlyTherms) || monthlyTherms.length !== 12) {
    throw new Error("monthlyTherms must have 12 values");
  }
  const allowance = allowanceByMonth(gasUtility);
  const { baseline, non_baseline: nonBaseline } = gasUtility.rates_per_therm;
  const minPerDay = gasUtility.minimum_bill.per_day;

  const lines = { baseline: 0, nonBaseline: 0, minimumBillTopUp: 0 };
  const monthly = new Array(12).fill(0);

  for (let m = 0; m < 12; m++) {
    const days = daysInCalendarMonth(year, m);
    const therms = Math.max(0, monthlyTherms[m]);
    // The baseline allowance is a per-day figure; a month earns it for each of
    // its days, so a longer month carries a larger baseline tier.
    const allowTherms = allowance[m] * days;
    const inBaseline = Math.min(therms, allowTherms);
    const above = therms - inBaseline;

    let cost = inBaseline * baseline + above * nonBaseline;
    // The minimum bill is a floor on the month, not a separate charge — a month
    // that prices below it is topped up to it. Recorded on its own line so the
    // top-up is visible rather than hidden inside the commodity total.
    const floor = minPerDay * days;
    const topUp = Math.max(0, floor - cost);

    lines.baseline += inBaseline * baseline;
    lines.nonBaseline += above * nonBaseline;
    lines.minimumBillTopUp += topUp;
    monthly[m] = cost + topUp;
  }

  return { total: monthly.reduce((a, b) => a + b, 0), lines, monthly };
}

/**
 * The annual $ the gas bill drops by removing one appliance's therms from the
 * household total, re-tiered month by month (and re-floored at the minimum
 * bill). Not `therms_removed x average_rate`: removing an appliance can pull a
 * month out of the non-baseline tier back into baseline, or down onto the
 * minimum-bill floor, and only a full re-cost of the remainder captures that.
 */
export function gasSavingsFromRemoving({ gasUtility, monthlyThermsTotal, applianceMonthlyTherms, year = 2025 }) {
  const before = costGasYear({ gasUtility, monthlyTherms: monthlyThermsTotal, year }).total;
  const after = costGasYear({
    gasUtility,
    monthlyTherms: monthlyThermsTotal.map((t, i) => Math.max(0, t - applianceMonthlyTherms[i])),
    year,
  }).total;
  return before - after;
}
