#!/usr/bin/env node
// Known-answer check: cost a real interval export and compare to the printed bill.
//
//   node tools/verify.mjs <green-button.csv>
//
// Passing validate.mjs means the rate files are structurally sound. It cannot
// tell whether the math on top of them is right. This can.
//
// The reference bill is NOT in the repo — it contains personal data. Its line
// items are recorded as plain numbers below, which is enough to regression-test
// the engine without carrying anyone's address around.

import { readFileSync, readdirSync } from "node:fs";
import { parseIntervals, localDateKey } from "../src/parse.js";
import { costPlan } from "../src/cost.js";
import { buildHistory } from "../src/revisions.js";
import { createCalendar, resolveHolidays } from "../src/calendar.js";
import { billingMonths } from "../src/period.js";
import { trueUp } from "../src/trueup.js";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: node tools/verify.mjs <green-button.csv>");
  process.exit(2);
}

const utility = JSON.parse(readFileSync("rates/sdge.json", "utf8"));

// Past revisions, so a period that spans a rate change can be priced on both
// sides of it. This bill is exactly that case: it states outright that charges
// ran at "Rate 1" for 4 days and "Rate 2" for 25. See the "rate revision"
// diagnostic below for what applying them actually does to the fit.
//
// Read from disk rather than from the manifest so that removing a history file
// makes this run degrade rather than fail.
const history = (() => {
  try {
    return readdirSync("rates/history")
      .filter((f) => f.endsWith(".json") && f !== "index.json")
      .map((f) => JSON.parse(readFileSync(`rates/history/${f}`, "utf8")));
  } catch {
    return [];
  }
})();

// ---------------------------------------------------------------------------
// Second reference bill: a NEM 2.0 solar account.
//
// CEA Clean Impact Plus customer on TOU-DR1, inland, 2022 PCIA vintage, 32 days
// ending Jul 6 2026. A net generator over the month: -157 kWh net, but 497 kWh
// of import once exports are netted interval by interval.
//
// This bill is what established the two things the NEM 2.0 path had wrong:
// netting runs per TOU period per billing month (not per interval across the
// period), and the volumetric adders use a different, smaller base than the
// non-bypassable charges. It also prints its own TOU period split, which is why
// the bucket totals below can be checked directly.
// ---------------------------------------------------------------------------
const NEM_BILL = {
  plan: "tou-dr1",
  overlay: "rates/cca-cea-clean-impact-plus.json",
  pciaVintage: 2022,
  climateZone: "inland",
  from: "2026-06-05",
  to: "2026-07-06",
  days: 32,
  netKWh: -157,
  nbcUsageKWh: 497,
  positiveTouKWh: 156,
  baselineAllowanceKWh: 333,
  nettedDeliveryRate: 0.3144, // printed on the bill; UDC total less PPP and CTC
  delivery: 49.05,
  baseServicesCharge: 25.39,
  nonbypassable: 7.5 + 2.94,
  ccaGeneration: 59.1,
  pcia: 4.69,
  stateRegulatoryFee: 0.16,
  // Not in the City of San Diego, so the franchise fee is the 1.1% base with no
  // differential. The other reference bill is a City of San Diego account and
  // was charged 6.88% — 1.1 + 5.78 — which is how the two were reconciled to a
  // single rule out of the Preliminary Statement.
  inCityOfSanDiego: false,
  franchiseFeeEquivalent: 0.63,
  // Published monthly TOU splits from the bill's Net Energy Metering Summary.
  // Only the periods under the current tariff — see verifyNem2 for why.
  touByMonth: [
    ["2026-03-06", "2026-04-03", { On: 146, Off: 45, Super: -63 }],
    ["2026-04-04", "2026-05-05", { On: 91, Off: -129, Super: -300 }],
    ["2026-05-06", "2026-06-04", { On: 117, Off: -63, Super: -245 }],
    ["2026-06-05", "2026-07-06", { On: 156, Off: -69, Super: -244 }],
  ],
};

// ---------------------------------------------------------------------------
// Third reference bill: a NEM 2.0 account that exports far more than it imports.
//
// SDCP PowerOn customer on EV-TOU-5, coastal, 2021 vintage, City of San Diego,
// 31 days ending Jun 29 2026. Net -831 kWh, and every delivery and generation
// line on the bill prints $0.00 — the whole bill is the two charges credits
// cannot touch.
//
// This is what established that the credit floor is the Base Services Charge
// *plus* the non-bypassable charges, not the Base Services Charge alone. The
// franchise fees below the line ($1.83 + $0.19) were cancelled to the cent by an
// Applied Generation Credit, which is the direct evidence that fees are
// offsettable and these two are not.
// ---------------------------------------------------------------------------
const EXPORTER_BILL = {
  plan: "ev-tou-5",
  overlay: "rates/cca-sdcp-2021v-poweron.json",
  pciaVintage: 2021,
  climateZone: "coastal",
  inCityOfSanDiego: true,
  from: "2026-05-30",
  to: "2026-06-29",
  days: 31,
  netKWh: -831,
  baseServicesCharge: 24.60,
  delivery: 0,
  nonbypassable: 7.12 + 2.79,
  // The CCA prints each TOU bucket as a credit and sums them into "Credited to
  // NEM Balance", so this line is checkable against a positive printed figure.
  ccaGeneration: -125.99,
  totalElectricCharges: 34.51,
  // Printed below the total and then cancelled by an Applied Generation Credit,
  // so it never reaches this bill's total — but it is the only known answer we
  // have for the differential's base, which no other reference bill pins.
  franchiseFeeDifferential: 1.83,
  // From the Net Energy Metering Summary, which totals the whole bill period
  // rather than splitting it by season the way the charge detail does.
  touByMonth: [["2026-05-30", "2026-06-29", { On: -171, Off: -364, Super: -296 }]],
  // From the Net Energy Metering Summary, which prints the Relevant Period
  // outright: a 12-month window with a named start and true-up date. Note the
  // kWh balance is the raw signed total, not the TOU-netted figure the charge
  // detail uses — SC 3(h) settles net surplus on the former.
  trueUp: {
    start: "2026-05-30",
    date: "2027-05-28",
    firstBillingMonthDays: 31,
    relevantPeriodKWh: -831.42,
  },
};

// ---------------------------------------------------------------------------
// Fourth reference bill: a period that spans a rate change, itemised.
//
// SDCP customer on EV-TOU-5, coastal, 2021 vintage, City of San Diego, 32 days
// ending Apr 27 2026. No solar.
//
// This is the bill that pins how SDG&E bills a mid-period rate change, because
// it prints BOTH segments in full — kWh per TOU period and dollars, twice over:
//
//   "There was a rate change on day 6 of your Billing Period. Therefore, your
//    charges for the first 5 days were at Rate 1, and the remaining 27 days
//    were at Rate 2."
//
// So the rule is: split at the effective date, bucket each segment's kWh by TOU
// period independently, and price each at its own revision's rates. Adders too —
// PCIA is charged twice, 97 kWh at 0.03557 and 406 kWh at 0.03564. That is the
// algorithm src/cost.js implements, and this checks it against printed figures
// rather than against a synthetic fixture.
// ---------------------------------------------------------------------------
const REVISION_BILL = {
  plan: "ev-tou-5",
  overlay: "rates/cca-sdcp-2021v-poweron.json",
  pciaVintage: 2021,
  climateZone: "coastal",
  inCityOfSanDiego: true,
  from: "2026-03-27",
  to: "2026-04-27",
  days: 32,
  kWh: 503,
  baseServicesCharge: 25.39,
  // Segment 1 is the 2026-01-01 revision, segment 2 the 2026-04-01 one.
  // Delivery here excludes WF-NBC, which the bill lines out separately.
  segments: [
    { days: 5, kWh: 97, delivery: 11.29, generation: 9.63, pcia: 3.45, pciaRate: 0.03557 },
    { days: 27, kWh: 406, delivery: 56.13, generation: 42.42, pcia: 14.47, pciaRate: 0.03564 },
  ],
  deliveryUDC: 11.29 + 56.13,
  wildfireFund: 2.97,
  generationSDGE: 9.63 + 42.42,
  pcia: 3.45 + 14.47,
  stateRegulatoryFee: 0.50,
  totalElectricCharges: 113.69,
};

// ---------------------------------------------------------------------------
// The reference bill. SDCP customer on EV-TOU-5, 2021 PCIA vintage,
// 29 days ending Jun 25 2026, 450 kWh.
// ---------------------------------------------------------------------------
const BILL = {
  plan: "ev-tou-5",
  overlay: "rates/cca-sdcp-2021v-poweron.json",
  pciaVintage: 2021,
  days: 29,
  kWh: 450,
  baseServicesCharge: 23.01,
  deliveryUDC: 7.98 + 51.57,
  wildfireFund: 2.66,
  generationSDGE: 6.37 + 57.1,
  pcia: 16.04,
  totalElectricCharges: 101.25,
};

// WF-NBC is folded into this file's delivery prices; the bill lines it out
// separately. Split it back out to compare like with like.
const WF_NBC = 0.00591;

const { intervals, warnings, meta } = parseIntervals(readFileSync(csvPath, "utf8"));

// Three reference bills, three different accounts. Pick by what the file
// contains rather than by a flag: an export channel says it is one of the two
// solar accounts, and the net kWh over each bill's own window says which — the
// two differ by a factor of five there, so there is no ambiguity to resolve.
if (intervals.some((iv) => iv.generationKWh > 0)) {
  const netOver = (B) => {
    let net = 0;
    let n = 0;
    for (const iv of intervals) {
      const k = localDateKey(iv.start);
      if (k >= B.from && k <= B.to) { net += iv.kWh - iv.generationKWh; n++; }
    }
    return n ? net : NaN;
  };
  const match = [NEM_BILL, EXPORTER_BILL].find((B) => Math.abs(netOver(B) - B.netKWh) < 5);
  if (!match) {
    console.error("This export has solar but matches neither NEM reference bill's window and net kWh.");
    process.exit(2);
  }
  verifyNem2(intervals, meta, warnings, match);
}

// A file with no solar that reaches back over the Apr 1 2026 rate change is the
// revision-split account, not the 29-day one — the latter starts in May.
if (localDateKey(intervals[0].start) <= REVISION_BILL.from &&
    localDateKey(intervals.at(-1).start) >= REVISION_BILL.to) {
  verifyRevisionSplit(intervals, meta, warnings, REVISION_BILL);
}

const billTimeline = buildHistory({
  utility,
  utilityHistory: history,
  from: intervals[0].start,
  to: intervals.at(-1).start,
});

const costBill = (history) => costPlan({
  utility,
  planId: BILL.plan,
  intervals,
  overlay: JSON.parse(readFileSync(BILL.overlay, "utf8")),
  climateZone: "coastal",
  pciaVintage: BILL.pciaVintage,
  history,
});

const result = costBill(billTimeline);
const withoutHistory = costBill(null);

// SDG&E's own generation, for the line the bill charges then credits back.
const bundled = costPlan({
  utility, planId: BILL.plan, intervals, climateZone: "coastal", history: billTimeline,
});

const wildfire = result.totalKWh * WF_NBC;

const checks = [
  ["Days in period", result.days, BILL.days, 0],
  ["Total kWh", result.totalKWh, BILL.kWh, 0.5],
  ["Base Services Charge", result.lines.fixed, BILL.baseServicesCharge, 0.02],
  ["Electricity Delivery (UDC)", result.lines.delivery - wildfire, BILL.deliveryUDC, 0.5],
  ["Wildfire Fund Charge", wildfire, BILL.wildfireFund, 0.02],
  ["SDG&E Generation (imputed)", bundled.lines.generation, BILL.generationSDGE, 0.5],
  ["PCIA (2021 vintage)", result.lines.pcia, BILL.pcia, 0.05],
];

// On a CCA bill SDG&E charges its own generation and credits it back in full,
// so those two cancel and what remains is delivery + fixed + adders.
const sdgeSideTotal =
  result.lines.fixed + result.lines.delivery + result.lines.pcia - 0.01; // -0.01 CTC disclosure
// 0.30, up from 0.25 when this ran at current rates throughout. The extra is not
// slack for the archive to hide in — it is the quantified cost of the bill
// rounding kWh per TOU bucket, and the per-segment diagnostic below is what
// keeps that claim checkable rather than assumed.
checks.push(["Total Electric Charges", sdgeSideTotal, BILL.totalElectricCharges, 0.30]);

let failed = 0;
const w = 30;
console.log(`Source: ${meta.intervalCount} intervals, ${meta.format}`);
console.log(`Period: ${meta.start.toDateString()} - ${meta.end.toDateString()}\n`);
console.log(`${"line".padEnd(w)} ${"computed".padStart(10)} ${"bill".padStart(10)} ${"diff".padStart(9)}`);

for (const [label, got, want, tol] of checks) {
  const diff = got - want;
  const ok = Math.abs(diff) <= tol;
  if (!ok) failed++;
  console.log(
    `${label.padEnd(w)} ${fmt(got).padStart(10)} ${fmt(want).padStart(10)} ` +
      `${fmt(diff).padStart(9)}  ${ok ? "ok" : "FAIL"}`,
  );
}

// Holiday resolution is data-driven and easy to get subtly wrong, so assert the
// known calendar rather than trusting it.
const HOLIDAYS_2026 = {
  "2026-01-01": "New Year's Day",
  "2026-02-16": "Presidents' Day",
  "2026-05-25": "Memorial Day",
  "2026-07-04": "Independence Day",
  "2026-09-07": "Labor Day",
  "2026-11-11": "Veterans Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
};
const resolved = resolveHolidays(utility.day_types, 2026);
let holidayFails = 0;
for (const [date, name] of Object.entries(HOLIDAYS_2026)) {
  if (resolved.get(date) !== name) {
    console.log(`\nFAIL holiday ${date}: expected ${name}, got ${resolved.get(date) ?? "none"}`);
    holidayFails++;
  }
}
// Juneteenth is not a TOU holiday under Rule 1 — confirmed independently by the
// bill's own bucket totals. Guard against it creeping back in.
if (resolved.has("2026-06-19")) {
  console.log("\nFAIL Juneteenth resolved as a holiday — Rule 1 does not list it");
  holidayFails++;
}
const cal = createCalendar(utility);
if (cal.dayTypeOf(new Date(2026, 4, 25)) !== "weekend") {
  console.log("\nFAIL Memorial Day should price on the weekend tree");
  holidayFails++;
}

failed += holidayFails;
console.log(
  `\nHolidays: ${Object.keys(HOLIDAYS_2026).length} rules resolved, ` +
    `${holidayFails ? holidayFails + " FAILED" : "all correct"}`,
);

// --- rate revision diagnostic ----------------------------------------------
//
// This bill spans a rate change AND the winter/summer boundary, both on Jun 1:
// 4 days at the 2026-04-01 revision (UDC 0.32682) and 25 at the 2026-06-01 one
// (0.31711), with generation switching from winter to summer rates at the same
// moment. It prints both segments, so the split is checkable directly:
//
//     segment    days     kWh (bill)    delivery (bill)
//     pre-Jun 1     4    62.35 (62)      8.13 (7.98)
//     Jun 1 on     25   387.93 (388)    51.67 (51.57)
//
// The day and kWh splits land exactly. What is left is the bill rounding each
// TOU bucket's kWh to a whole number before pricing it, which loses a fraction
// six times over.
//
// Worth recording because it looked like the opposite for a while: costing the
// whole period at current rates fits the TOTAL better (+0.06 against +0.25), but
// only by accident — underpricing those 4 days cancels the rounding excess. Two
// errors in opposite directions is not agreement, and the per-segment figures
// above are what show it.
if (billTimeline && Math.abs(withoutHistory.lines.delivery - result.lines.delivery) > 1e-9) {
  const wf = result.totalKWh * WF_NBC;
  console.log(`\n${"archive on vs off".padEnd(w)} ${"computed".padStart(10)} ${"bill".padStart(10)} ${"diff".padStart(9)}`);
  for (const [label, got] of [
    ["Delivery, archive applied", result.lines.delivery - wf],
    ["Delivery, current rates only", withoutHistory.lines.delivery - withoutHistory.totalKWh * WF_NBC],
  ]) {
    console.log(
      `${label.padEnd(w)} ${fmt(got).padStart(10)} ${fmt(BILL.deliveryUDC).padStart(10)} ` +
        `${fmt(got - BILL.deliveryUDC).padStart(9)}`,
    );
  }
}

for (const warn of warnings) console.log(`\nWARN ${warn}`);
for (const warn of result.warnings) console.log(`WARN ${warn}`);

console.log(failed ? `\nFAIL — ${failed} check(s) outside tolerance` : "\nPASS — all checks within tolerance");
process.exit(failed ? 1 : 0);

/**
 * Known-answer check for the NEM 2.0 path, against the solar reference bill.
 *
 * Exits the process — this is a whole second verification run, not a section of
 * the first, because it uses a different account on a different schedule.
 */
function verifyNem2(allIntervals, srcMeta, srcWarnings, B) {
  const inPeriod = (from, to) =>
    allIntervals.filter((iv) => {
      const k = localDateKey(iv.start);
      return k >= from && k <= to;
    });

  const sel = inPeriod(B.from, B.to);
  if (!sel.length) {
    console.error(`This export has solar but no data for ${B.from}..${B.to}, so the NEM ` +
      `reference bill cannot be checked against it.`);
    process.exit(2);
  }

  const r = costPlan({
    utility,
    planId: B.plan,
    intervals: sel,
    overlay: JSON.parse(readFileSync(B.overlay, "utf8")),
    climateZone: B.climateZone,
    pciaVintage: B.pciaVintage,
    inCityOfSanDiego: B.inCityOfSanDiego,
    nem: { mode: "nem2" },
  });

  const nbc = utility.plans.find((p) => p.id === B.plan).nonbypassable_charges;
  const flatDelivery = utility.plans.find((p) => p.id === B.plan)
    .delivery.summer.weekday[0].price_per_kwh;

  // Each bill prints a different subset of lines — the net exporter's delivery
  // and generation detail is all zeroes and it is charged no PCIA or state fee,
  // because those ride on import it does not have. Check what the bill states
  // and skip what it does not, rather than inventing an expectation for it.
  const checks = [
    ["Days in period", r.days, B.days, 0],
    ["Net kWh (total usage)", r.totalKWh, B.netKWh, 1],
    ["Baseline allowance kWh", r.baselineAllowanceKWh, B.baselineAllowanceKWh, 1],
    ["Netted delivery $/kWh", flatDelivery - nbc.total_per_kwh, B.nettedDeliveryRate, 1e-9],
    ["Base Services Charge", r.lines.fixed, B.baseServicesCharge, 0.02],
    ["Electricity Delivery", r.lines.delivery, B.delivery, 0.75],
    ["Non-Bypassable Charges", r.lines.nonbypassable, B.nonbypassable, 0.05],
    ["CCA Generation", r.lines.generation, B.ccaGeneration, 0.25],
    [`PCIA (${B.pciaVintage} vintage)`, r.lines.pcia, B.pcia, 0.10],
    ["State Regulatory Fee", r.lines.stateRegulatoryFee, B.stateRegulatoryFee, 0.02],
    ["Franchise Fee Equivalent", r.lines.franchiseFeeEquivalent, B.franchiseFeeEquivalent, 0.05],
    ["Franchise Fee Differential", r.lines.franchiseFeeDifferential, B.franchiseFeeDifferential, 0.02],
    // Only the exporter bill states this directly: with every volumetric line at
    // zero, its Total Electric Charges *is* the credit floor, so this single
    // number is the whole known-answer check for what credits cannot offset.
    ["Total Electric Charges", r.total, B.totalElectricCharges, 0.05],
  ].filter(([, , want]) => want != null);

  let failed = 0;
  const w = 30;
  console.log(`Source: ${srcMeta.intervalCount} intervals, ${srcMeta.format}`);
  console.log(`NEM 2.0 reference bill: ${B.from} .. ${B.to}\n`);
  console.log(`${"line".padEnd(w)} ${"computed".padStart(10)} ${"bill".padStart(10)} ${"diff".padStart(9)}`);
  for (const [label, got, want, tol] of checks) {
    const diff = got - want;
    const ok = Math.abs(diff) <= tol;
    if (!ok) failed++;
    console.log(`${label.padEnd(w)} ${fmt(got).padStart(10)} ${fmt(want).padStart(10)} ` +
      `${fmt(diff).padStart(9)}  ${ok ? "ok" : "FAIL"}`);
  }

  // The bill publishes its own TOU period split each month, which checks season
  // boundaries, holiday handling and the TOU windows all at once — a far
  // stronger test than any single dollar figure.
  //
  // Only the periods from March 2026 on: the midday super-off-peak window is
  // absent from earlier months, which is a tariff change the single-revision
  // rate file cannot represent. Those months reproduce On-Peak and the net total
  // exactly and misplace roughly 180 kWh between off-peak and super-off-peak.
  const cal = createCalendar(utility);
  const plan = utility.plans.find((p) => p.id === B.plan);
  const periodOf = (iv) => {
    const s = cal.seasonOf(iv.start);
    const d = cal.dayTypeOf(iv.start);
    const h = iv.start.getHours();
    const blocks = plan.generation[s][d];
    const price = blocks.find((x) => h >= x.start_hour && h < x.end_hour).price_per_kwh;
    const ranked = [...new Set(blocks.map((x) => x.price_per_kwh))].sort((a, b) => b - a);
    return ["On", "Off", "Super"][ranked.indexOf(price)];
  };

  let touFails = 0;
  console.log(`\n${"TOU period split".padEnd(w)} ${"computed".padStart(10)} ${"bill".padStart(10)}`);
  for (const [from, to, want] of B.touByMonth) {
    const got = { On: 0, Off: 0, Super: 0 };
    for (const iv of inPeriod(from, to)) got[periodOf(iv)] += iv.kWh - iv.generationKWh;
    for (const key of ["On", "Off", "Super"]) {
      const ok = Math.abs(Math.round(got[key]) - want[key]) <= 1;
      if (!ok) touFails++;
      console.log(`${`${from.slice(5)}..${to.slice(5)} ${key}`.padEnd(w)} ` +
        `${fmt(got[key]).padStart(10)} ${String(want[key]).padStart(10)}  ${ok ? "ok" : "FAIL"}`);
    }
  }
  failed += touFails;

  // The Relevant Period, which the bill prints in full: start date, true-up
  // date, and the running kWh balance that SC 3(h) settles surplus on. This
  // bill is the first month of its period, so the balance printed is simply
  // this month's — which is what makes it checkable at all.
  if (B.trueUp) {
    const asDate = (s) => {
      const [y, m, d] = s.split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const [ty, tm, td] = B.trueUp.date.split("-").map(Number);
    const period = {
      start: asDate(B.trueUp.start),
      trueUp: asDate(B.trueUp.date),
      complete: false, // the data stops long before the anniversary
      // Clamped to the bill's own window, so what we compute is the balance as
      // of this statement — which is the number the bill actually prints.
      covered: { from: asDate(B.trueUp.start), to: asDate(B.to) },
    };
    const t = trueUp({ intervals: sel, period, ledger: r.ledger });
    const cycleDays = billingMonths(period.start, period.start, td)[0].days;

    const trueUpChecks = [
      ["Relevant period kWh", t.netKWh, B.trueUp.relevantPeriodKWh, 1],
      ["Billing cycle days", cycleDays, B.trueUp.firstBillingMonthDays, 0],
    ];
    console.log(`\n${"true-up".padEnd(w)} ${"computed".padStart(10)} ${"bill".padStart(10)}`);
    for (const [label, got, want, tol] of trueUpChecks) {
      const ok = Math.abs(got - want) <= tol;
      if (!ok) failed++;
      console.log(`${label.padEnd(w)} ${fmt(got).padStart(10)} ${fmt(want).padStart(10)}  ${ok ? "ok" : "FAIL"}`);
    }

    // Structural, not numeric. The bill lists Non-Bypassable Charges outside the
    // credit ledger and bills them monthly, so a standing credit balance must
    // not reduce them — SC 3, "cannot be offset by generation credits". This
    // account ends the month deep in credit and still owes the full NBC line, so
    // the two conditions together are the assertion.
    const inCredit = r.ledger.length > 0 && r.ledger.at(-1).cumulativeBalance < 0;
    const ok = inCredit && r.total >= r.lines.nonbypassable - 1e-9;
    if (!ok) failed++;
    console.log(`${"NBC survives a credit balance".padEnd(w)} ${(ok ? "yes" : "no").padStart(10)} ` +
      `${"yes".padStart(10)}  ${ok ? "ok" : "FAIL"}`);
    console.log(`${"True-up date".padEnd(w)} ${localDateKey(t.trueUp).padStart(10)} ` +
      `${B.trueUp.date.padStart(10)}  ${localDateKey(t.trueUp) === B.trueUp.date ? "ok" : "FAIL"}`);
    if (localDateKey(t.trueUp) !== B.trueUp.date) failed++;
  }

  for (const warn of srcWarnings) console.log(`\nWARN ${warn}`);
  for (const warn of r.warnings) console.log(`WARN ${warn}`);
  if (B.baselineAllowanceKWh != null) {
    console.log(
      "\nNot checked here: the Baseline Adjustment Credit, which the bill applied to " +
      "144 kWh where every base we can derive gives 156. Recorded in README under " +
      "\"Needs verifying\".",
    );
  }
  console.log(failed ? `\nFAIL — ${failed} check(s) outside tolerance` : "\nPASS — all checks within tolerance");
  process.exit(failed ? 1 : 0);
}

function fmt(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Known-answer check for a billing period that spans a rate revision.
 *
 * Exits the process, like verifyNem2 — a different account on a different
 * window, not a section of the first run.
 *
 * The point of this check is that the bill itemises BOTH segments, so it
 * verifies the split itself and not merely the total. A total can come out right
 * with the segments wrong in compensating directions; the per-segment delivery
 * and PCIA lines cannot.
 */
function verifyRevisionSplit(allIntervals, srcMeta, srcWarnings, B) {
  const sel = allIntervals.filter((iv) => {
    const k = localDateKey(iv.start);
    return k >= B.from && k <= B.to;
  });
  if (!sel.length) {
    console.error(`No data for ${B.from}..${B.to}.`);
    process.exit(2);
  }

  const timeline = buildHistory({
    utility, utilityHistory: history, from: sel[0].start, to: sel.at(-1).start,
  });
  if (!timeline) {
    console.error("No archived revisions on disk, so the rate-change split cannot be checked.");
    process.exit(2);
  }

  const opts = {
    utility, planId: B.plan, intervals: sel,
    overlay: JSON.parse(readFileSync(B.overlay, "utf8")),
    climateZone: B.climateZone, pciaVintage: B.pciaVintage,
    inCityOfSanDiego: B.inCityOfSanDiego,
  };
  const r = costPlan({ ...opts, history: timeline });
  const flat = costPlan(opts);
  const bundled = costPlan({
    utility, planId: B.plan, intervals: sel, climateZone: B.climateZone, history: timeline,
  });

  const wildfire = r.totalKWh * WF_NBC;
  const w = 34;
  let failed = 0;

  console.log(`Source: ${srcMeta.intervalCount} intervals, ${srcMeta.format}`);
  console.log(`Rate-change reference bill: ${B.from} .. ${B.to}\n`);
  console.log(`${"line".padEnd(w)} ${"computed".padStart(10)} ${"bill".padStart(10)} ${"diff".padStart(9)}`);

  const row = (label, got, want, tol) => {
    const ok = Math.abs(got - want) <= tol;
    if (!ok) failed++;
    console.log(`${label.padEnd(w)} ${fmt(got).padStart(10)} ${fmt(want).padStart(10)} ` +
      `${fmt(got - want).padStart(9)}  ${ok ? "ok" : "FAIL"}`);
  };

  row("Days in period", r.days, B.days, 0);
  row("Total kWh", r.totalKWh, B.kWh, 1);
  row("Base Services Charge", r.lines.fixed, B.baseServicesCharge, 0.02);
  row("Electricity Delivery (UDC)", r.lines.delivery - wildfire, B.deliveryUDC, 0.5);
  row("Wildfire Fund Charge", wildfire, B.wildfireFund, 0.03);
  row("SDG&E Generation (imputed)", bundled.lines.generation, B.generationSDGE, 0.5);
  row("PCIA (2021 vintage, both rates)", r.lines.pcia, B.pcia, 0.05);
  row("State Regulatory Fee", r.lines.stateRegulatoryFee, B.stateRegulatoryFee, 0.02);

  const sdgeSideTotal = r.lines.fixed + r.lines.delivery + r.lines.pcia - 0.01;
  row("Total Electric Charges", sdgeSideTotal, B.totalElectricCharges, 0.5);

  // The whole reason this bill was worth adding: does the archive help? The
  // flat run prices all 32 days at the current revision, which is what the
  // calculator did before rates/history existed.
  console.log(`\n${"archive on vs off".padEnd(w)} ${"computed".padStart(10)} ${"bill".padStart(10)} ${"diff".padStart(9)}`);
  for (const [label, got] of [
    ["Delivery, archive applied", r.lines.delivery - wildfire],
    ["Delivery, current rates only", flat.lines.delivery - flat.totalKWh * WF_NBC],
    ["PCIA, archive applied", r.lines.pcia],
    ["PCIA, current rates only", flat.lines.pcia],
  ]) {
    const want = label.startsWith("Delivery") ? B.deliveryUDC : B.pcia;
    console.log(`${label.padEnd(w)} ${fmt(got).padStart(10)} ${fmt(want).padStart(10)} ` +
      `${fmt(got - want).padStart(9)}`);
  }

  for (const warn of srcWarnings) console.log(`\nWARN ${warn}`);
  for (const warn of r.warnings) console.log(`WARN ${warn}`);

  console.log(failed ? `\nFAIL — ${failed} check(s) outside tolerance` : "\nPASS — all checks within tolerance");
  process.exit(failed ? 1 : 0);
}
