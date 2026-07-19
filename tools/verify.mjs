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
import { parseIntervals } from "../src/parse.js";
import { costPlan } from "../src/cost.js";
import { createCalendar, resolveHolidays } from "../src/calendar.js";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: node tools/verify.mjs <green-button.csv>");
  process.exit(2);
}

const utility = JSON.parse(readFileSync("rates/sdge.json", "utf8"));

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

function fmt(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}
