#!/usr/bin/env node
// Unit checks for the parts of the engine the reference bill cannot exercise.
//
//   node tools/test.mjs
//
// The bill is a TOU plan in summer with no DST transition in it, so tiered
// pricing, DST days, and the parser's format quirks are all unverified by it.

import { readFileSync } from "node:fs";
import { parseSdgeCsv, parseIntervals, localDateKey } from "../src/parse.js";
import { createCalendar, resolveHolidays, expectedIntervalsForDay } from "../src/calendar.js";
import { costPlan } from "../src/cost.js";

const utility = JSON.parse(readFileSync("rates/sdge.json", "utf8"));
let failed = 0;

function check(name, got, want, tol = 0) {
  const ok = typeof want === "number" ? Math.abs(got - want) <= tol : got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${got}, want ${want}`}`);
}

// --- parser quirks ---------------------------------------------------------
// Quote-wrapped fields, 12-hour times with meridiem, CRLF line endings. Each of
// these caused a silent zero-row parse during development.
const csv =
  "Name,Someone\r\n" +
  "Meter Number,Date,Start Time,Duration,Consumption,Generation,Net\r\n" +
  '"123","5/28/2026","12:00 AM","15","1.5100","0.0000","1.5100"\r\n' +
  '"123","5/28/2026","12:15 PM","15","2.0000","0.0000","2.0000"\r\n' +
  '"123","5/28/2026","11:45 PM","15","0.5000","0.0000","0.5000"\r\n';

const p = parseSdgeCsv(csv);
check("csv: parses all rows", p.intervals.length, 3);
check("csv: midnight is hour 0", p.intervals[0].start.getHours(), 0);
check("csv: 12:15 PM is hour 12", p.intervals[1].start.getHours(), 12);
check("csv: 11:45 PM is hour 23", p.intervals[2].start.getHours(), 23);
check("csv: duration minutes -> seconds", p.intervals[0].durationSeconds, 900);
check("csv: total kWh", p.meta.totalKWh, 4.01, 1e-9);
check("csv: strips PII", Object.keys(p.meta).includes("meterNumber"), false);
check("format sniffing: xml", (() => {
  try {
    parseIntervals("<?xml version='1.0'?><feed></feed>");
  } catch (e) {
    return e.message.includes("IntervalReading");
  }
  return "no throw";
})(), true);

// --- calendar --------------------------------------------------------------
const cal = createCalendar(utility);
check("season: Jun 1 is summer", cal.seasonOf(new Date(2026, 5, 1)), "summer");
check("season: Oct 31 is summer", cal.seasonOf(new Date(2026, 9, 31)), "summer");
check("season: Nov 1 is winter", cal.seasonOf(new Date(2026, 10, 1)), "winter");
// Winter wraps the year boundary — the range test has to flip for it.
check("season: Jan 15 is winter", cal.seasonOf(new Date(2026, 0, 15)), "winter");
check("season: May 31 is winter", cal.seasonOf(new Date(2026, 4, 31)), "winter");

check("holiday: Memorial Day prices as weekend", cal.dayTypeOf(new Date(2026, 4, 25)), "weekend");
check("holiday: ordinary Tuesday is weekday", cal.dayTypeOf(new Date(2026, 4, 26)), "weekday");
check("holiday: Juneteenth is NOT observed", cal.holidayName(new Date(2026, 5, 19)), null);

// Rule 1 shifts Sunday holidays to Monday, and leaves Saturday alone.
// 2027-12-25 falls on a Saturday; 2027-01-01 on a Friday. 2032-07-04 is a Sunday.
check("holiday: Sunday shifts to Monday", resolveHolidays(utility.day_types, 2032).has("2032-07-05"), true);
check("holiday: Sunday original date not kept", resolveHolidays(utility.day_types, 2032).has("2032-07-04"), false);
check("holiday: Saturday does not shift", resolveHolidays(utility.day_types, 2027).has("2027-12-25"), true);

// --- DST -------------------------------------------------------------------
// 2026-03-08 is the spring-forward day (23 hours), 2026-11-01 falls back (25).
// A fixed 96 would flag both as incomplete days.
check("dst: spring forward day has 92 intervals", expectedIntervalsForDay(new Date(2026, 2, 8), 900), 92);
check("dst: fall back day has 100 intervals", expectedIntervalsForDay(new Date(2026, 10, 1), 900), 100);
check("dst: ordinary day has 96", expectedIntervalsForDay(new Date(2026, 5, 15), 900), 96);
check("localDateKey is local, not UTC", localDateKey(new Date(2026, 0, 1, 23, 30)), "2026-01-01");

// --- tiered pricing (DR) ---------------------------------------------------
// One winter day, coastal basic allowance 9.2 kWh/day, so the 130% tier
// boundary sits at 11.96 kWh. Delivery is 0.22876 below and 0.33539 above.
const oneDay = (kwhPerInterval, count) =>
  Array.from({ length: count }, (_, i) => ({
    start: new Date(2026, 0, 5, Math.floor(i / 4), (i % 4) * 15),
    durationSeconds: 900,
    kWh: kwhPerInterval,
    generationKWh: 0,
    netKWh: kwhPerInterval,
  }));

const under = costPlan({ utility, planId: "dr", intervals: oneDay(0.1, 96), climateZone: "coastal" });
check("dr: baseline allowance for 1 winter day", under.baselineAllowanceKWh, 9.2, 1e-9);
check("dr: 9.6 kWh all in tier 1", under.lines.delivery, 9.6 * 0.22876, 1e-6);

const over = costPlan({ utility, planId: "dr", intervals: oneDay(0.25, 96), climateZone: "coastal" });
// 24 kWh: first 11.96 at tier 1, remaining 12.04 at tier 2.
check("dr: 24 kWh splits across tiers", over.lines.delivery, 11.96 * 0.22876 + 12.04 * 0.33539, 1e-6);
check("dr: generation is flat across tiers", over.lines.generation, 24 * 0.18274, 1e-6);
// DR's baseline credit is folded into its tier-1 price; applying it again would
// double-count, so the credit line must stay zero.
check("dr: no separate baseline credit", over.lines.baselineCredit, 0);

// A hotter zone gets a bigger allowance, so the same usage costs less.
const desert = costPlan({ utility, planId: "dr", intervals: oneDay(0.25, 96), climateZone: "desert" });
check("dr: desert zone is cheaper for same usage", desert.lines.delivery < over.lines.delivery, true);

// --- baseline credit on TOU-DR1 -------------------------------------------
const dr1 = costPlan({ utility, planId: "tou-dr1", intervals: oneDay(0.25, 96), climateZone: "coastal" });
check("tou-dr1: credit capped at 130% of baseline", dr1.lines.baselineCredit, 11.96 * -0.10663, 1e-6);
const dr1Small = costPlan({ utility, planId: "tou-dr1", intervals: oneDay(0.05, 96), climateZone: "coastal" });
check("tou-dr1: credit limited by usage when under baseline", dr1Small.lines.baselineCredit, 4.8 * -0.10663, 1e-6);

// --- fixed charges ---------------------------------------------------------
// EV-TOU overrides the file-level block: no service charge, but a minimum bill.
const evtou = costPlan({ utility, planId: "ev-tou", intervals: oneDay(0.25, 96), climateZone: "coastal" });
check("ev-tou: no daily service charge", evtou.lines.fixed, 0);
const dr1Fixed = costPlan({ utility, planId: "tou-dr1", intervals: oneDay(0.25, 96), climateZone: "coastal" });
check("tou-dr1: one day of service charge", dr1Fixed.lines.fixed, 0.79343, 1e-9);

// --- CCA structure ---------------------------------------------------------
// A CCA overlay must change generation only — delivery and fixed stay put.
const overlay = JSON.parse(readFileSync("rates/cca-sdcp-2021v-poweron.json", "utf8"));
const bundled = costPlan({ utility, planId: "tou-dr1", intervals: oneDay(0.25, 96), climateZone: "coastal" });
const cca = costPlan({ utility, planId: "tou-dr1", intervals: oneDay(0.25, 96), climateZone: "coastal", overlay, pciaVintage: 2021 });
check("cca: delivery unchanged", cca.lines.delivery, bundled.lines.delivery, 1e-9);
check("cca: fixed unchanged", cca.lines.fixed, bundled.lines.fixed, 1e-9);
check("cca: generation differs", cca.lines.generation !== bundled.lines.generation, true);
check("cca: pcia charged", cca.lines.pcia, 24 * 0.03564, 1e-6);
check("bundled: no pcia", bundled.lines.pcia, 0);

// PCIA vintage matters: 2009 and 2024 differ by more than 3x.
const v2009 = costPlan({ utility, planId: "tou-dr1", intervals: oneDay(0.25, 96), climateZone: "coastal", overlay, pciaVintage: 2009 });
check("cca: 2009 vintage pcia differs from 2021", v2009.lines.pcia, 24 * 0.01538, 1e-6);

// CEA's rate relief credit reduces generation rather than being folded in.
const cea = JSON.parse(readFileSync("rates/cca-cea-clean-impact.json", "utf8"));
const ceaCost = costPlan({ utility, planId: "tou-dr1", intervals: oneDay(0.25, 96), climateZone: "coastal", overlay: cea, pciaVintage: 2021 });
check("cea: generation credit applied", ceaCost.lines.generationCredit, 24 * -0.03871, 1e-6);

// --- period selection and trimming -----------------------------------------
import { trimIncompleteDays, selectPeriod, describePeriod, hourlyShape, applyLoadProfile } from "../src/period.js";

// Two full days plus a half day at the end, which is what a real export looks like.
const twoAndAHalf = [
  ...oneDay(0.1, 96).map((iv) => ({ ...iv, start: new Date(2026, 0, 5, iv.start.getHours(), iv.start.getMinutes()) })),
  ...oneDay(0.1, 96).map((iv) => ({ ...iv, start: new Date(2026, 0, 6, iv.start.getHours(), iv.start.getMinutes()) })),
  ...oneDay(0.1, 40).map((iv) => ({ ...iv, start: new Date(2026, 0, 7, iv.start.getHours(), iv.start.getMinutes()) })),
];
const trimmed = trimIncompleteDays(twoAndAHalf);
check("trim: drops the partial day", trimmed.intervals.length, 192);
check("trim: reports what it dropped", trimmed.dropped[0].date, "2026-01-07");
check("trim: reports expected count", trimmed.dropped[0].expected, 96);

// A complete DST day must survive trimming. 2026-11-01 falls back, so it holds
// 100 intervals, not 96 — trimming against a fixed 96 would keep it, but
// trimming a 92-interval spring-forward day against 96 would wrongly drop it.
const springForward = Array.from({ length: 92 }, (_, i) => ({
  start: new Date(2026, 2, 8, 0, 0, 0, 0).getTime() + i * 900000,
  durationSeconds: 900, kWh: 0.1, generationKWh: 0, netKWh: 0.1,
})).map((iv) => ({ ...iv, start: new Date(iv.start) }));
check("trim: keeps a complete spring-forward day", trimIncompleteDays(springForward).intervals.length, 92);

check("period: full returns everything", selectPeriod(twoAndAHalf, "full").length, twoAndAHalf.length);
const spanning = [
  ...oneDay(0.1, 96).map((iv) => ({ ...iv, start: new Date(2025, 11, 20, iv.start.getHours()) })),
  ...oneDay(0.1, 96).map((iv) => ({ ...iv, start: new Date(2026, 0, 5, iv.start.getHours()) })),
];
check("period: ytd cuts to Jan 1", selectPeriod(spanning, "ytd").length, 96);

const desc = describePeriod(trimmed.intervals, utility);
check("describe: counts days", desc.dayCount, 2);
check("describe: identifies winter", desc.seasons.join(), "winter");
check("describe: flags missing summer", desc.missingSeasons.join(), "summer");
check("describe: not a full year", desc.spansFullYear, false);

// --- load profiles ---------------------------------------------------------
const evOvernight = JSON.parse(readFileSync("profiles/ev-overnight.json", "utf8"));
check("profile: shape sums to 1", Math.abs(evOvernight.hourly_shape.reduce((a, b) => a + b, 0) - 1) < 0.001, true);

const day = oneDay(0.1, 96);
const boosted = applyLoadProfile(day, evOvernight, 3650); // 10 kWh/day
const addedTotal = boosted.reduce((s, i) => s + i.kWh, 0) - day.reduce((s, i) => s + i.kWh, 0);
check("profile: adds annual/365 kWh to one day", addedTotal, 10, 1e-6);
// The whole point: an overnight profile must land in the small hours, not spread flat.
const shape = hourlyShape(boosted);
check("profile: overnight load lands before 6am", shape[2] > shape[18], true);
check("profile: evening hours unchanged by overnight profile", shape[18], 0.4, 1e-6);

// Timing changes the answer even when kWh is identical. This is the claim the
// added-load feature makes, so assert it rather than trusting it.
const evEvening = JSON.parse(readFileSync("profiles/ev-evening.json", "utf8"));
const nightCost = costPlan({ utility, planId: "tou-dr1", intervals: applyLoadProfile(day, evOvernight, 3650), climateZone: "coastal" });
const eveCost = costPlan({ utility, planId: "tou-dr1", intervals: applyLoadProfile(day, evEvening, 3650), climateZone: "coastal" });
check("profile: same kWh costs more in the evening", eveCost.total > nightCost.total, true);

// --- error handling --------------------------------------------------------
check("unknown plan throws", (() => {
  try { costPlan({ utility, planId: "nope", intervals: oneDay(0.1, 96) }); } catch (e) { return true; }
  return false;
})(), true);
check("unknown climate zone throws", (() => {
  try { costPlan({ utility, planId: "dr", intervals: oneDay(0.1, 96), climateZone: "tundra" }); } catch (e) { return true; }
  return false;
})(), true);
check("plan the CCA does not serve throws", (() => {
  const partial = { ...overlay, plans: { "tou-dr1": overlay.plans["tou-dr1"] } };
  try { costPlan({ utility, planId: "dr", intervals: oneDay(0.1, 96), overlay: partial, pciaVintage: 2021 }); } catch (e) { return true; }
  return false;
})(), true);

console.log(failed ? `\nFAIL — ${failed} check(s)` : "\nPASS — all checks");
process.exit(failed ? 1 : 0);
