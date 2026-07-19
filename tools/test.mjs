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
import { costPlan, rankPlans } from "../src/cost.js";
import { nemEligiblePlans } from "../src/nem.js";

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

// Every existing load profile, pinned to the cent-fraction. applyLoadProfile
// grew a clamp and an import/export split so solar could ride the same path;
// these totals were recorded before that change and must not move by so much as
// a rounding bit. A load profile is always positive, so the new branch is dead
// code for all six — this is the check that proves it stayed dead.
const PINNED = {
  "ev-evening": 10.1856032,
  "ev-midday": 8.7877432,
  "ev-overnight": 8.7877432,
  "heat-pump": 9.698182654,
  "pool-pump": 9.090282584,
  "water-heater": 9.722516409,
};
for (const [id, want] of Object.entries(PINNED)) {
  const prof = JSON.parse(readFileSync(`profiles/${id}.json`, "utf8"));
  const series = applyLoadProfile(day, prof, 3650);
  const got = costPlan({ utility, planId: "tou-dr1", intervals: series, climateZone: "coastal" });
  check(`profile: ${id} costs exactly what it did before the solar change`, got.total, want, 1e-8);
  check(`profile: ${id} exports nothing`, series.every((iv) => iv.generationKWh === 0), true);
}

// --- solar: NEM 2.0 --------------------------------------------------------
// Exports net against imports at full retail, but non-bypassable charges are
// billed on import and survive the netting. A house that exports exactly what
// it imports owes no energy and still owes those.

const exportTable = JSON.parse(readFileSync("rates/nbt-export.json", "utf8"));
const NBC = utility.plans.find((x) => x.id === "tou-dr1").nonbypassable_charges.total_per_kwh;

/** One winter day where each interval imports `imp` and exports `exp`. */
const solarDay = (imp, exp, day = 5) =>
  Array.from({ length: 96 }, (_, i) => ({
    start: new Date(2026, 0, day, Math.floor(i / 4), (i % 4) * 15),
    durationSeconds: 900,
    kWh: imp,
    generationKWh: exp,
    netKWh: imp - exp,
  }));

const nem2 = (intervals, extra = {}) =>
  costPlan({
    utility, planId: "tou-dr1", intervals, climateZone: "coastal",
    nem: { mode: "nem2" }, ...extra,
  });

const netZero = nem2(solarDay(0.2, 0.2));
check("nem2: net-zero day has zero net consumption", netZero.totalKWh, 0, 1e-9);
check("nem2: net-zero day costs nothing for energy", netZero.lines.delivery + netZero.lines.generation, 0, 1e-9);
// 96 intervals x 0.2 kWh imported = 19.2 kWh, all of it at positive interval net
// of zero... which is zero. Exports exactly cancel, so the NBC base is zero too.
check("nem2: net-zero day owes no NBC either", netZero.lines.nonbypassable, 0, 1e-9);
check("nem2: but still owes the daily service charge", netZero.lines.fixed > 0, true);

// Half the intervals export more than they import, half less: net is zero
// overall, but the importing intervals still carry NBCs.
const alternating = solarDay(0.2, 0).map((iv, i) =>
  i % 2 === 0 ? { ...iv, kWh: 0.4, generationKWh: 0, netKWh: 0.4 }
              : { ...iv, kWh: 0, generationKWh: 0.4, netKWh: -0.4 });
const alt = nem2(alternating);
check("nem2: alternating day nets to zero kWh", alt.totalKWh, 0, 1e-9);
check("nem2: NBC billed on the importing intervals only", alt.lines.nonbypassable, 48 * 0.4 * NBC, 1e-9);
check("nem2: exporting intervals add nothing to the NBC base", alt.lines.nonbypassable > 0, true);

// Energy nets at retail in both directions, so a symmetric pair cancels exactly.
const importOnly = nem2(solarDay(0.4, 0));
const symmetric = nem2(alternating);
check("nem2: netting is symmetric at retail",
  symmetric.lines.delivery + symmetric.lines.generation, 0, 1e-9);
check("nem2: import-only day costs more than the netted one", importOnly.total > symmetric.total, true);

// The netted delivery price is retail minus NBC, and NBC is billed separately —
// so the two together must come back to the full retail price.
const grossDelivery = 96 * 0.4 * 0.33539;
check("nem2: netted delivery + NBC reconstructs full retail delivery",
  importOnly.lines.delivery + importOnly.lines.nonbypassable, grossDelivery, 1e-9);

// A net generator gets no baseline credit, and never a negative one.
const generator = nem2(solarDay(0.05, 0.5));
check("nem2: net generator has negative net consumption", generator.totalKWh < 0, true);
check("nem2: net generator earns no baseline credit", generator.lines.baselineCredit, 0, 1e-9);
check("nem2: bill never goes negative", generator.total >= 0, true);
check("nem2: leftover credit is reported, not paid", generator.unusedCredit > 0, true);

// PCIA follows the NBC base, not gross usage: an hour of surplus does not earn
// the exit fee back. Every interval here both imports and exports, so gross
// import (38.4) and import-net-of-export (28.8) are different numbers — if they
// were equal this check could not tell the two bases apart.
const partial = solarDay(0.4, 0.1);
const ccaNem2 = nem2(partial, { overlay, pciaVintage: 2021 });
const pciaRate = utility.cca_adders.pcia_by_vintage["2021"];
check("nem2: PCIA charged on import net of exports",
  ccaNem2.lines.pcia, 96 * 0.3 * pciaRate, 1e-9);
check("nem2: PCIA is not charged on gross import",
  Math.abs(ccaNem2.lines.pcia - 96 * 0.4 * pciaRate) > 1e-6, true);
check("nem2: NBC uses that same net-of-export base",
  ccaNem2.lines.nonbypassable, 96 * 0.3 * NBC, 1e-9);

// A tiered plan is not eligible, and NEM 2.0 needs the NBC block to run at all.
check("nem2: rejects a plan with no nonbypassable_charges", (() => {
  const stripped = { ...utility, plans: utility.plans.map((x) =>
    x.id === "tou-dr1" ? { ...x, nonbypassable_charges: undefined } : x) };
  try {
    costPlan({ utility: stripped, planId: "tou-dr1", intervals: solarDay(0.2, 0.1), nem: { mode: "nem2" } });
  } catch (e) { return e.message.includes("nonbypassable"); }
  return "no throw";
})(), true);

// Netting runs per TOU period per billing month, and delivery floors at zero in
// each period. Both facts come from the solar reference bill, which printed
// On-Peak +156 / Off-Peak -69 / Super-Off-Peak -244 and still charged delivery
// on 156 kWh — a signed sum across periods would have charged -157.
//
// A day that is a net generator overall but a net consumer on-peak. The
// off-peak block alternates importing and exporting intervals so that the
// period nets negative while individual intervals still import — which is what
// separates the two adder bases from each other.
const mixedDay = solarDay(0, 0).map((iv, i) => {
  const hour = Math.floor(i / 4);
  if (hour >= 16 && hour < 21) return { ...iv, kWh: 0.5, generationKWh: 0, netKWh: 0.5 };
  if (hour >= 10 && hour < 14) return { ...iv, kWh: 0, generationKWh: 2.0, netKWh: -2.0 };
  if (hour >= 6 && hour < 10) {
    return i % 2 === 0
      ? { ...iv, kWh: 0.4, generationKWh: 0, netKWh: 0.4 }
      : { ...iv, kWh: 0, generationKWh: 0.5, netKWh: -0.5 };
  }
  return iv;
});
const mixed = nem2(mixedDay);
check("nem2: a net-generating day still bills the on-peak period", mixed.lines.delivery > 0, true);
check("nem2: net total is still negative", mixed.totalKWh < 0, true);
// On-peak net = 20 x 0.5 = 10 kWh at the netted delivery price. The exporting
// periods contribute nothing to delivery.
check("nem2: delivery charged on the positive period only",
  mixed.lines.delivery, 10 * (0.33539 - NBC), 1e-9);
// Generation is not floored — the CCA credits negative periods at full rate,
// which the reference bill shows explicitly.
check("nem2: generation still credits the exporting periods", mixed.lines.generation < 0, true);

// Volumetric adders use the positive-TOU-period base, not the larger
// per-interval NBC base. On the reference bill these were 156 and 497 kWh.
// Positive TOU net is on-peak only (10 kWh) — the off-peak block nets negative.
// The NBC base also picks up the importing half of that block (8 x 0.4 = 3.2).
const mixedCCA = nem2(mixedDay, { overlay, pciaVintage: 2021 });
const pcia2021 = utility.cca_adders.pcia_by_vintage["2021"];
check("nem2: PCIA uses the positive-TOU base", mixedCCA.lines.pcia, 10 * pcia2021, 1e-9);
check("nem2: NBC uses the larger per-interval base",
  mixedCCA.lines.nonbypassable, (10 + 3.2) * NBC, 1e-9);
check("nem2: the two bases genuinely differ",
  mixedCCA.lines.nonbypassable / NBC > mixedCCA.lines.pcia / pcia2021, true);

// --- solar: NEM 3.0 --------------------------------------------------------
// Imports bill gross at retail; exports earn the avoided-cost credit for that
// month, day type and hour. Nothing nets.

const nem3 = (intervals, extra = {}) =>
  costPlan({
    utility, planId: "ev-tou-5", intervals, climateZone: "coastal",
    nem: { mode: "nem3", vintage: "NBT26", exportTable }, ...extra,
  });

// Jan 5 2026 is a Monday: weekday rows.
const jan = exportTable.vintages.NBT26["2026"];
const expectedCredit = (day, exp) => {
  const dayType = new Date(2026, 0, day).getDay() === 1 ? "weekday" : "weekend";
  let total = 0;
  for (let hour = 0; hour < 24; hour++) {
    total += 4 * exp * (jan.generation["1"][dayType][hour] + jan.delivery["1"][dayType][hour]);
  }
  return total;
};

const nbt = nem3(solarDay(0.2, 0.3));
check("nem3: imports are billed gross, not net", nbt.totalKWh, 96 * 0.2, 1e-9);
check("nem3: export credit matches the published table",
  nbt.lines.exportCredit, expectedCredit(5, 0.3), 1e-9);
check("nem3: no non-bypassable line — imports are already gross", nbt.lines.nonbypassable, 0);

// Same kWh exported, different hour: the table is not flat, so this must differ.
const middayOnly = solarDay(0.2, 0).map((iv, i) =>
  Math.floor(i / 4) === 12 ? { ...iv, generationKWh: 1.0 } : iv);
const eveningOnly = solarDay(0.2, 0).map((iv, i) =>
  Math.floor(i / 4) === 18 ? { ...iv, generationKWh: 1.0 } : iv);
check("nem3: export timing changes the credit",
  Math.abs(nem3(middayOnly).lines.exportCredit - nem3(eveningOnly).lines.exportCredit) > 0.01, true);

// Holidays price off the weekend row. Jan 1 2026 is New Year's Day, a Thursday —
// so weekday-vs-weekend is decided by the holiday rule, not the day of week.
const holidayExport = nem3(solarDay(0.2, 0.3, 1));
check("nem3: a holiday is priced from the weekend row",
  holidayExport.lines.exportCredit, expectedCredit(1, 0.3), 1e-9);
check("nem3: Jan 1 2026 is a weekday by date", new Date(2026, 0, 1).getDay(), 4);

// CCA adders land on the export credit and nowhere else.
const sdcpAdder = JSON.parse(readFileSync("rates/cca-sdcp-2021v-poweron.json", "utf8"));
const ceaAdder = JSON.parse(readFileSync("rates/cca-cea-clean-impact.json", "utf8"));
check("nem3: SDCP adder is 0.0075", sdcpAdder.nbt_generation_adder_per_kwh, 0.0075);
check("nem3: CEA adder is 0.01", ceaAdder.nbt_generation_adder_per_kwh, 0.01);

const bundledCredit = nem3(solarDay(0.2, 0.3)).lines.exportCredit;
const sdcpCredit = nem3(solarDay(0.2, 0.3), { overlay: sdcpAdder, pciaVintage: 2021 }).lines.exportCredit;
const exportedKWh = 96 * 0.3;
check("nem3: CCA adder raises the export credit by exactly adder x kWh",
  sdcpCredit - bundledCredit, exportedKWh * 0.0075, 1e-9);

// The vintage/year lookup has to actually vary, or the nine-year lock-in means
// nothing. All three vintages happen to agree for calendar 2026 — checked
// against the source CSVs — so the year axis is where the difference shows.
check("nem3: the same vintage prices different years differently",
  exportTable.vintages.NBT25["2025"].generation["9"].weekday[19] !==
    exportTable.vintages.NBT25["2026"].generation["9"].weekday[19], true);

// An unknown vintage must fail loudly rather than pricing exports at zero.
check("nem3: unknown vintage throws", (() => {
  try { nem3(solarDay(0.2, 0.3), { nem: { mode: "nem3", vintage: "NBT99", exportTable } }); }
  catch (e) { return e.message.includes("NBT99"); }
  return "no throw";
})(), true);

// --- solar: eligibility ----------------------------------------------------
const { allowed: nem3Plans, excluded: nem3Excluded } = nemEligiblePlans("nem3", utility.plans);
check("eligibility: NEM 3.0 allows only EV-TOU-5", nem3Plans.map((x) => x.id).join(), "ev-tou-5");
check("eligibility: NEM 3.0 explains every exclusion",
  nem3Excluded.every((x) => x.reason.includes("EV-TOU-5")), true);

const { allowed: nem2Plans } = nemEligiblePlans("nem2", utility.plans);
check("eligibility: NEM 2.0 excludes the tiered plan", nem2Plans.some((x) => x.id === "dr"), false);
check("eligibility: NEM 2.0 keeps the TOU plans", nem2Plans.length, utility.plans.length - 1);
check("eligibility: no solar means no filtering",
  nemEligiblePlans("none", utility.plans).allowed.length, utility.plans.length);

const ranked = rankPlans({
  utility, intervals: solarDay(0.2, 0.1), climateZone: "coastal",
  nem: { mode: "nem3", vintage: "NBT26", exportTable },
});
check("eligibility: ranking under NEM 3.0 returns one plan", ranked.length, 1);
check("eligibility: ranking reports what it dropped", ranked.excluded.length, utility.plans.length - 1);

// --- solar: no export data in the file --------------------------------------
// The dangerous case. Selecting a NEM plan on a non-solar export must warn
// rather than quietly returning a number that looks like a solar bill.
const noSolar = nem2(solarDay(0.2, 0));
check("nem2: warns when the file carries no exported energy",
  noSolar.warnings.some((w) => w.includes("no exported energy")), true);
check("nem2: with no exports, NBC base is the whole import",
  noSolar.lines.nonbypassable, 96 * 0.2 * NBC, 1e-9);
// And the total must match a plain non-solar run: netting nothing changes nothing.
const plain = costPlan({ utility, planId: "tou-dr1", intervals: solarDay(0.2, 0), climateZone: "coastal" });
check("nem2: no exports gives the same total as no solar at all",
  noSolar.total, plain.total, 1e-9);

// --- solar as a generation profile -----------------------------------------
// Solar is applyLoadProfile with the sign flipped. The engine gains no tariff
// logic; what has to hold is that the transform splits a signed net into the
// meter's two registers correctly.

import { applyBattery, createPriceRanker, BATTERY_SIZES } from "../src/scenario.js";

const solarProfile = JSON.parse(readFileSync("profiles/solar-rooftop.json", "utf8"));
check("solar profile: 12 months x 24 hours",
  solarProfile.monthly_shape.length === 12 && solarProfile.monthly_shape.every((r) => r.length === 24), true);
check("solar profile: normalizes to 1 across the whole table",
  solarProfile.monthly_shape.flat().reduce((a, b) => a + b, 0), 1, 1e-5);
check("solar profile: declares itself generation", solarProfile.kind, "generation");
check("solar profile: nothing produced at midnight in any month",
  solarProfile.monthly_shape.every((r) => r[0] === 0 && r[23] === 0), true);
// Peak production sits an hour later on the clock in summer than in winter,
// because the clock moves and the sun does not. Getting this backwards would
// walk production out of the on-peak window.
const peakHour = (m) => solarProfile.monthly_shape[m].indexOf(Math.max(...solarProfile.monthly_shape[m]));
check("solar profile: DST shifts the peak an hour later in summer",
  peakHour(6) - peakHour(11), 1);

const julyDay = Array.from({ length: 96 }, (_, i) => ({
  start: new Date(2026, 6, 15, Math.floor(i / 4), (i % 4) * 15),
  durationSeconds: 900, kWh: 0.1, generationKWh: 0, netKWh: 0.1,
}));
const withSolar = applyLoadProfile(julyDay, solarProfile, 9300);
check("solar: import never goes negative", withSolar.every((iv) => iv.kWh >= 0), true);
check("solar: midday exports", withSolar.some((iv) => iv.generationKWh > 0), true);
check("solar: night is untouched",
  withSolar[0].kWh, 0.1, 1e-12);
// import - export must still equal the signed net, or the two registers have
// drifted apart from the arithmetic that produced them.
check("solar: registers reconcile to the signed net",
  withSolar.every((iv) => Math.abs((iv.kWh - iv.generationKWh) - iv.netKWh) < 1e-12), true);
const solarCost = costPlan({ utility, planId: "ev-tou-5", intervals: withSolar, climateZone: "coastal",
  nem: { mode: "nem3", vintage: "NBT26", exportTable } });
const noSolarCost = costPlan({ utility, planId: "ev-tou-5", intervals: julyDay, climateZone: "coastal" });
check("solar: lowers the bill", solarCost.total < noSolarCost.total, true);

// A monthly shape must route by month. A December interval reading January's
// row would be invisible in any total-based check.
const decDay = julyDay.map((iv) => ({ ...iv, start: new Date(2026, 11, 15, iv.start.getHours(), iv.start.getMinutes()) }));
const decSolar = applyLoadProfile(decDay, solarProfile, 9300);
const julyProduced = withSolar.reduce((s, iv) => s + (iv.kWh - iv.netKWh), 0);
const decProduced = decSolar.reduce((s, iv) => s + (iv.kWh - iv.netKWh), 0);
check("solar: December produces less than July", decProduced < julyProduced, true);

// --- battery ----------------------------------------------------------------
const evtou5 = utility.plans.find((p) => p.id === "ev-tou-5");
const rankAt = createPriceRanker({ plan: evtou5, calendar: cal });
check("price ranker: the most expensive hour ranks 1", (() => {
  const ranks = Array.from({ length: 24 }, (_, h) => rankAt(new Date(2026, 6, 15, h)).rank);
  return Math.max(...ranks) === 1 && Math.min(...ranks) === 0;
})(), true);
// The windows must come from the plan, not from a constant. TOU-DR1 and
// EV-TOU-5 price different hours, so their top-ranked hours must differ
// somewhere or the derivation is not reading the plan at all.
const rankDr1 = createPriceRanker({ plan: utility.plans.find((p) => p.id === "tou-dr1"), calendar: cal });
check("price ranker: reads each plan's own curve", (() => {
  const a = Array.from({ length: 24 }, (_, h) => rankAt(new Date(2026, 0, 15, h)).rank);
  const b = Array.from({ length: 24 }, (_, h) => rankDr1(new Date(2026, 0, 15, h)).rank);
  return a.some((v, i) => Math.abs(v - b[i]) > 1e-9);
})(), true);

const noBattery = applyBattery(julyDay, { capacityKWh: 0, powerKW: 0, rankAt });
check("battery: zero capacity is exactly a no-op", noBattery.intervals, julyDay);

// A battery has to be tested against a realistic week, not a flat day. Its
// whole job is to move energy from midday into the evening peak, so a fixture
// with no evening peak and only one day of carry-over measures nothing. Load is
// evening-weighted and the system is sized to the house, which is the case a
// buyer is actually in.
const eveningShape = (h) => (h >= 17 && h < 22 ? 2.2 : h >= 6 && h < 9 ? 1.2 : 0.55);
const solarWeek = Array.from({ length: 96 * 7 }, (_, i) => {
  const start = new Date(2026, 6, 13, 0, i * 15);
  const kWh = eveningShape(start.getHours()) / 4;
  return { start, durationSeconds: 900, kWh, generationKWh: 0, netKWh: kWh };
});
const weekWithSolar = applyLoadProfile(solarWeek, solarProfile, 8500);
const nbtOpts = { mode: "nem3", vintage: "NBT26", exportTable };
const weekSolarCost = costPlan({ utility, planId: "ev-tou-5", intervals: weekWithSolar,
  climateZone: "coastal", nem: nbtOpts });

const solarPlusBattery = applyBattery(weekWithSolar, { ...BATTERY_SIZES.small, strategy: "solar", rankAt });
check("battery: never charges from the grid on the solar strategy",
  solarPlusBattery.chargedFromGridKWh, 0);
check("battery: discharges less than it charges (round-trip loss)",
  solarPlusBattery.dischargedKWh < solarPlusBattery.chargedKWh, true);
check("battery: stores surplus that would otherwise export",
  solarPlusBattery.intervals.reduce((s, iv) => s + iv.generationKWh, 0) <
    weekWithSolar.reduce((s, iv) => s + iv.generationKWh, 0), true);
const sbCost = costPlan({ utility, planId: "ev-tou-5", intervals: solarPlusBattery.intervals,
  climateZone: "coastal", nem: nbtOpts });
check("battery: a battery on top of solar lowers the bill further", sbCost.total < weekSolarCost.total, true);

// Grid arbitrage on a flat-load house with no solar. The two numbers must move
// in OPPOSITE directions: more kWh bought, fewer dollars spent. If total import
// fell, the battery would be manufacturing energy; if cost rose, it would be
// charging at the wrong end of the day.
const week = Array.from({ length: 96 * 7 }, (_, i) => ({
  start: new Date(2026, 6, 13, 0, i * 15),
  durationSeconds: 900, kWh: 0.25, generationKWh: 0, netKWh: 0.25,
}));
const arb = applyBattery(week, { ...BATTERY_SIZES.large, strategy: "grid", rankAt });
const importBefore = week.reduce((s, iv) => s + iv.kWh, 0);
const importAfter = arb.intervals.reduce((s, iv) => s + iv.kWh, 0);
const costBefore = costPlan({ utility, planId: "ev-tou-5", intervals: week, climateZone: "coastal" });
const costAfter = costPlan({ utility, planId: "ev-tou-5", intervals: arb.intervals, climateZone: "coastal" });
check("battery: grid arbitrage buys more kWh", importAfter > importBefore, true);
check("battery: grid arbitrage still costs less", costAfter.total < costBefore.total, true);
check("battery: grid arbitrage never exports",
  arb.intervals.every((iv) => iv.generationKWh === 0), true);

// State of charge is internal, so assert it through what escapes: discharge can
// never exceed what the reserve floor leaves reachable, nor the power limit.
check("battery: respects the power limit per interval",
  arb.intervals.every((iv, i) => Math.abs(iv.kWh - week[i].kWh) <= BATTERY_SIZES.large.powerKW * 0.25 + 1e-9), true);
check("battery: a tiered plan is refused rather than mis-scheduled", (() => {
  try {
    createPriceRanker({ plan: utility.plans.find((p) => p.id === "dr"), calendar: cal });
    return false;
  } catch { return true; }
})(), true);

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
