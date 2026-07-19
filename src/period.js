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
 * Apply a load profile to a series: an hourly *shape* scaled to an annual kWh,
 * not a flat monthly total. Charging an EV at 1am and at 6pm produce opposite
 * conclusions from the same kWh, which is the entire point of this feature.
 */
export function applyLoadProfile(intervals, profile, annualKWh) {
  const perHourPerDay = profile.hourly_shape.map((f) => (f * annualKWh) / 365);
  const byDay = groupByDay(intervals);

  return intervals.map((iv) => {
    const hour = iv.start.getHours();
    const slotsThisHour = byDay
      .get(localDateKey(iv.start))
      .filter((x) => x.start.getHours() === hour).length || 1;
    const added = perHourPerDay[hour] / slotsThisHour;
    return { ...iv, kWh: iv.kWh + added, netKWh: iv.netKWh + added };
  });
}
