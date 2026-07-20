// Selecting and trimming the slice of imported data that gets costed.
//
// Seasonal pricing means a partial year is not a small version of a full year —
// summer peak rates dominate the annual answer, so a winter-only export ranks
// plans differently than a full year would. Everything here exists to make that
// visible rather than silently wrong.

import { localDateKey } from "./parse.js";
import { expectedIntervalsForDay } from "./calendar.js";

/** Group intervals by local calendar day, preserving order. */
export function groupByDay(intervals) {
  const days = new Map();
  for (const iv of intervals) {
    const key = localDateKey(iv.start);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(iv);
  }
  return days;
}

/** Most common interval duration in the series; the export's native resolution. */
export function modalDuration(intervals) {
  const counts = new Map();
  for (const iv of intervals) {
    counts.set(iv.durationSeconds, (counts.get(iv.durationSeconds) ?? 0) + 1);
  }
  let best = 900;
  let most = 0;
  for (const [dur, n] of counts) {
    if (n > most) {
      most = n;
      best = dur;
    }
  }
  return best;
}

/**
 * Drop days that don't hold a full day of intervals.
 *
 * Green Button exports usually start and end mid-day, and a partial day drags
 * down averages and misstates the daily-shape chart.
 *
 * The expected count is computed from the day's actual local length, NOT
 * assumed to be 96. DST transition days genuinely have 23 and 25 hours, so a
 * fixed count would flag two legitimate days a year as incomplete.
 */
export function trimIncompleteDays(intervals) {
  const duration = modalDuration(intervals);
  const days = groupByDay(intervals);
  const kept = [];
  const dropped = [];

  for (const [key, dayIntervals] of days) {
    const expected = expectedIntervalsForDay(dayIntervals[0].start, duration);
    if (dayIntervals.length >= expected) {
      kept.push(...dayIntervals);
    } else {
      dropped.push({ date: key, got: dayIntervals.length, expected });
    }
  }
  return { intervals: kept, dropped };
}

/**
 * @param {string} mode "full" (everything) or "ytd" (Jan 1 through end of data)
 */
export function selectPeriod(intervals, mode) {
  if (mode !== "ytd" || !intervals.length) return intervals;
  const lastYear = intervals.at(-1).start.getFullYear();
  const cutoff = new Date(lastYear, 0, 1);
  return intervals.filter((iv) => iv.start >= cutoff);
}

/**
 * The billing months between two dates, anchored on a meter-read day.
 *
 * A billing period runs read to read: the reference bill covers 5/30 to 6/29,
 * 31 days, which is neither a calendar month nor a fixed number of days. Given
 * the anniversary day, each window starts on that day and ends the day before
 * the next one.
 *
 * `anniversaryDay` above 28 is clamped into short months, so a cycle anchored on
 * the 30th reads on Feb 28. That is what makes the window length vary, and it
 * is why the day count is returned rather than assumed.
 */
export function billingMonths(from, to, anniversaryDay) {
  if (!anniversaryDay) return [];
  const months = [];
  const dayIn = (y, m) => Math.min(anniversaryDay, new Date(y, m + 1, 0).getDate());

  // Step back to the read on or before `from`, so the first window is whole.
  let y = from.getFullYear();
  let m = from.getMonth();
  if (from.getDate() < dayIn(y, m)) m -= 1;

  for (;;) {
    const start = new Date(y, m, dayIn(y, m));
    const next = new Date(y, m + 1, dayIn(y, m + 1));
    const end = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
    if (start > to) break;
    months.push({
      from: start,
      to: end,
      days: Math.round((next - start) / 86400000),
    });
    y = next.getFullYear();
    m = next.getMonth();
  }
  return months;
}

/**
 * Split a span into Relevant Periods working backwards from the true-up date.
 *
 * Schedule NEM-ST SC 3 defines the Relevant Period as the 12 months ending at
 * the customer's anniversary, so the true-up date fixes the whole grid. Working
 * backwards rather than forwards from the file's first day matters: the period
 * the user cares about is the one their next true-up settles, and a 13-month
 * export straddles two of them.
 *
 * Each period reports whether the data actually covers all twelve months —
 * `complete` false means no eligibility claim should be made from it.
 */
export function relevantPeriods(from, to, trueUpDate) {
  if (!trueUpDate) return [];
  const periods = [];
  const day = trueUpDate.getDate();

  // Walk anniversaries back until one lands at or before the data starts.
  let end = new Date(trueUpDate);
  while (end > from) {
    const start = new Date(end.getFullYear() - 1, end.getMonth(), end.getDate());
    periods.unshift({
      start,
      trueUp: end,
      anniversaryDay: day,
      complete: start >= from && end <= to,
      covered: { from: start < from ? from : start, to: end > to ? to : end },
    });
    end = start;
  }
  return periods;
}

/**
 * Describe what the selected period actually covers, so the result can be
 * labelled honestly rather than presented as an annual figure.
 */
export function describePeriod(intervals, utility) {
  if (!intervals.length) return { dayCount: 0, seasons: [], missingSeasons: [], spansFullYear: false };

  const start = intervals[0].start;
  const end = intervals.at(-1).start;
  const dayCount = groupByDay(intervals).size;

  const seasonNames = Object.keys(utility.seasons);
  const present = new Set();
  // Sampling every interval is wasteful; one per day is enough to see a season.
  for (const [, dayIntervals] of groupByDay(intervals)) {
    present.add(seasonOfDate(dayIntervals[0].start, utility));
  }

  const monthsCovered = new Set();
  for (const [key] of groupByDay(intervals)) monthsCovered.add(key.slice(0, 7));

  return {
    start,
    end,
    dayCount,
    monthCount: monthsCovered.size,
    seasons: [...present],
    missingSeasons: seasonNames.filter((s) => !present.has(s)),
    spansFullYear: dayCount >= 365,
    label: `${dayCount} day${dayCount === 1 ? "" : "s"} (${fmt(start)} – ${fmt(end)})`,
  };
}

function seasonOfDate(date, utility) {
  const i = idx(date.getMonth() + 1, date.getDate());
  for (const [name, s] of Object.entries(utility.seasons)) {
    const [sm, sd] = s.start.split("-").map(Number);
    const [em, ed] = s.end.split("-").map(Number);
    const from = idx(sm, sd);
    const to = idx(em, ed);
    const inRange = from <= to ? i >= from && i <= to : i >= from || i <= to;
    if (inRange) return name;
  }
  return null;
}

const idx = (m, d) => Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 86400000);

const fmt = (d) =>
  d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Average kWh by hour of day, for the load-shape chart. */
export function hourlyShape(intervals) {
  const totals = new Array(24).fill(0);
  const dayCount = groupByDay(intervals).size || 1;
  for (const iv of intervals) totals[iv.start.getHours()] += iv.kWh;
  return totals.map((t) => t / dayCount);
}

/** Monthly kWh totals, for the seasonal chart. */
export function monthlyTotals(intervals) {
  const months = new Map();
  for (const iv of intervals) {
    const key = `${iv.start.getFullYear()}-${String(iv.start.getMonth() + 1).padStart(2, "0")}`;
    months.set(key, (months.get(key) ?? 0) + iv.kWh);
  }
  return [...months].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Apply a profile to a series: a normalized *shape* scaled to an annual kWh,
 * not a flat monthly total. Charging an EV at 1am and at 6pm produce opposite
 * conclusions from the same kWh, which is the entire point of this feature.
 *
 * Handles both directions. A load profile adds consumption; a `generation`
 * profile subtracts it, which is all rooftop solar is from the meter's point of
 * view. Separating the shape from the annual total is what makes solar tractable
 * here: the shape is generic to the region, while the magnitude depends on the
 * roof and belongs to whoever is looking at a quote for it.
 *
 * Two shape formats:
 *   hourly_shape  — 24 values, the same every day of the year.
 *   monthly_shape — 12 x 24, indexed [month-1][hour].
 *
 * Solar needs the second. December output is around half of June's and the sun
 * is not up at 6am in winter, so a single 24-value shape would put production in
 * hours that have none. That misallocation is worse than it sounds under NBT,
 * where the export credit for a kWh varies by an order of magnitude across the
 * year — moving production between months moves real money.
 */
export function applyLoadProfile(intervals, profile, annualKWh) {
  const monthly = profile.monthly_shape;
  if (!monthly && !profile.hourly_shape) {
    throw new Error(`Profile "${profile.id}" has neither hourly_shape nor monthly_shape.`);
  }

  // A monthly shape is normalized across the whole 12x24 table, so its values
  // are already a fraction of the *annual* total and must not be divided by 365
  // the way a daily shape is. Instead each month's slice is spread over that
  // month's days, which is also what makes short months come out right.
  const sign = profile.kind === "generation" ? -1 : 1;
  const byDay = groupByDay(intervals);

  const perDay = (date, hour) => {
    if (!monthly) return (profile.hourly_shape[hour] * annualKWh) / 365;
    const month = date.getMonth();
    // Divide by the days in the *calendar* month, not the days present in the
    // data. Using the data's day count would hand a household with three days
    // of July the whole month's production, which is how a partial import turns
    // into a wildly optimistic solar quote.
    return (monthly[month][hour] * annualKWh) / daysInCalendarMonth(date.getFullYear(), month);
  };

  return intervals.map((iv) => {
    const hour = iv.start.getHours();
    const slotsThisHour = byDay
      .get(localDateKey(iv.start))
      .filter((x) => x.start.getHours() === hour).length || 1;
    const delta = (sign * perDay(iv.start, hour)) / slotsThisHour;
    const net = iv.kWh + delta;

    // The meter has two registers, not one signed one. Negative net import is
    // an export, and cost.js reads `kWh` as grid import — leaving it negative
    // would run it through the delivery calculation as a discount instead of
    // through the export credit. Split it here, where the sign is still known.
    return {
      ...iv,
      kWh: Math.max(0, net),
      generationKWh: (iv.generationKWh ?? 0) + Math.max(0, -net),
      netKWh: iv.netKWh + delta,
    };
  });
}

/** Days in a calendar month, February included. */
function daysInCalendarMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
