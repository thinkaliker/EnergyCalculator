// Turning the controls into the option object costPlan expects.
//
// This sits between the selects and the panels that render results, and it
// depends on neither of the latter — which is what keeps results.js and
// scenario-panel.js from having to import each other or main.js.

import { $ } from "./dom.js";
import { state } from "./state.js";
import { currentCity, nemMode, nemOptions } from "./setup.js";
import { selectPeriod, trimIncompleteDays, relevantPeriods } from "../period.js";

/** The intervals actually being costed, after trimming and period selection. */
export function activeIntervals() {
  let out = state.raw;
  let dropped = [];
  if ($("trim").checked) ({ intervals: out, dropped } = trimIncompleteDays(out));
  out = selectPeriod(out, $("period").value);
  return { intervals: out, dropped };
}

export function costOptions(intervals, overlayDoc) {
  return {
    utility: state.utility,
    intervals,
    overlay: overlayDoc ?? null,
    climateZone: $("zone").value,
    baselineType: $("baseline-type").value,
    pciaVintage: Number($("vintage").value),
    inCityOfSanDiego: currentCity()?.name === "San Diego",
    nem: nemOptions(),
    // Past days price at the rates that were in force on them; days the current
    // revision covers price at it. The archive can only ever reach backwards.
    history: state.timeline,
    ...trueUpOptions(intervals),
  };
}

/**
 * The true-up date fixes the whole billing grid: its day of the month is the
 * meter-read day, and its anniversary is where carried credit stops.
 *
 * Only NEM 2.0 has a Relevant Period to settle, so nothing here applies to a
 * NEM 3.0 or non-solar household.
 */
function trueUpOptions(intervals) {
  if (nemMode() !== "nem2" || !intervals.length) return {};
  const date = trueUpDate(intervals);
  if (!date) return {};
  const periods = relevantPeriods(intervals[0].start, intervals.at(-1).start, date);
  return {
    billingCycleDay: date.getDate(),
    // A boundary only counts if the file actually spans it — otherwise there is
    // no month at which to forfeit anything.
    trueUpBoundaries: periods
      .filter((p) => p.trueUp <= intervals.at(-1).start)
      .map((p) => monthKeyOf(p.trueUp)),
  };
}

const monthKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/**
 * The user's true-up date, or an inferred one.
 *
 * Inferring is a guess and is labelled as such in the UI: we assume the period
 * ends twelve months after the data starts, which is right only by luck. The
 * bill prints the real date, so the field exists mainly to be corrected.
 */
export function trueUpDate(intervals) {
  const entered = $("trueup-date").value;
  if (entered) {
    const [y, m, d] = entered.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  if (!intervals.length) return null;
  const first = intervals[0].start;
  return new Date(first.getFullYear() + 1, first.getMonth(), first.getDate());
}
