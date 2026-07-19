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

import { readFileSync } from "node:fs";
import { parseIntervals, localDateKey } from "../src/parse.js";
import { costPlan } from "../src/cost.js";
import { createCalendar, resolveHolidays } from "../src/calendar.js";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: node tools/verify.mjs <green-button.csv>");
  process.exit(2);
}

const utility = JSON.parse(readFileSync("rates/sdge.json", "utf8"));

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

// Two reference bills, two different accounts. Pick by what the file contains
// rather than by a flag — only one of them has an export channel.
if (intervals.some((iv) => iv.generationKWh > 0)) {
  verifyNem2(intervals, meta, warnings);
}

const result = costPlan({
  utility,
  planId: BILL.plan,
  intervals,
  overlay: JSON.parse(readFileSync(BILL.overlay, "utf8")),
  climateZone: "coastal",
  pciaVintage: BILL.pciaVintage,
});

// SDG&E's own generation, for the line the bill charges then credits back.
const bundled = costPlan({ utility, planId: BILL.plan, intervals, climateZone: "coastal" });

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
checks.push(["Total Electric Charges", sdgeSideTotal, BILL.totalElectricCharges, 0.25]);

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
function verifyNem2(allIntervals, srcMeta, srcWarnings) {
  const B = NEM_BILL;
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

  const checks = [
    ["Days in period", r.days, B.days, 0],
    ["Net kWh (total usage)", r.totalKWh, B.netKWh, 1],
    ["Baseline allowance kWh", r.baselineAllowanceKWh, B.baselineAllowanceKWh, 1],
    ["Netted delivery $/kWh", flatDelivery - nbc.total_per_kwh, B.nettedDeliveryRate, 1e-9],
    ["Base Services Charge", r.lines.fixed, B.baseServicesCharge, 0.02],
    ["Electricity Delivery", r.lines.delivery, B.delivery, 0.75],
    ["Non-Bypassable Charges", r.lines.nonbypassable, B.nonbypassable, 0.05],
    ["CCA Generation", r.lines.generation, B.ccaGeneration, 0.25],
    ["PCIA (2022 vintage)", r.lines.pcia, B.pcia, 0.10],
    ["State Regulatory Fee", r.lines.stateRegulatoryFee, B.stateRegulatoryFee, 0.02],
    ["Franchise Fee Equivalent", r.lines.franchiseFeeEquivalent, B.franchiseFeeEquivalent, 0.05],
  ];

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

  for (const warn of srcWarnings) console.log(`\nWARN ${warn}`);
  for (const warn of r.warnings) console.log(`WARN ${warn}`);
  console.log(
    "\nNot checked here: the Baseline Adjustment Credit, which the bill applied to " +
    "144 kWh where every base we can derive gives 156. Recorded in README under " +
    "\"Needs verifying\".",
  );
  console.log(failed ? `\nFAIL — ${failed} check(s) outside tolerance` : "\nPASS — all checks within tolerance");
  process.exit(failed ? 1 : 0);
}

function fmt(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}
