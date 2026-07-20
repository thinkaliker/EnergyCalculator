// Season and day-type resolution, driven entirely by rates/sdge.json.
//
// Nothing here hardcodes a date. Seasons come from `seasons`, holidays from
// `day_types.holiday_rules` — so a tariff change is a data edit, not a code
// edit, and an imported year the file has never seen still resolves correctly.

import { localDateKey } from "./parse.js";

/**
 * Resolve the holiday rules for one year into local-date keys.
 *
 * Rule 1: when a listed holiday falls on a SUNDAY the following Monday is the
 * holiday instead. Saturday gets no observance — there is no Friday shift.
 * Getting that backwards silently misprices a day a year.
 */
export function resolveHolidays(dayTypes, year) {
  const out = new Map();
  for (const rule of dayTypes.holiday_rules ?? []) {
    let d = rule.day
      ? new Date(year, rule.month - 1, rule.day)
      : nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.nth);

    if (d.getDay() === 0 && dayTypes.sunday_observed_following_monday) {
      d = new Date(year, d.getMonth(), d.getDate() + 1);
    }
    out.set(localDateKey(d), rule.name);
  }
  return out;
}

/**
 * nth occurrence of an ISO weekday (1=Mon .. 7=Sun) in a month.
 * nth === -1 means the last one.
 */
function nthWeekdayOfMonth(year, month, isoWeekday, nth) {
  if (nth === -1) {
    const last = new Date(year, month, 0); // day 0 of next month = last of this
    const back = (isoDay(last) - isoWeekday + 7) % 7;
    return new Date(year, month - 1, last.getDate() - back);
  }
  const first = new Date(year, month - 1, 1);
  const forward = (isoWeekday - isoDay(first) + 7) % 7;
  return new Date(year, month - 1, 1 + forward + (nth - 1) * 7);
}

const isoDay = (d) => d.getDay() || 7; // JS Sunday=0 -> ISO Sunday=7

/** Day-of-year index in a non-leap reference year; season bounds are MM-DD only. */
const monthDayIndex = (month, day) =>
  Math.round((Date.UTC(2001, month - 1, day) - Date.UTC(2001, 0, 1)) / 86400000);

export function createCalendar(utility) {
  const holidayCache = new Map();
  const holidaysFor = (year) => {
    if (!holidayCache.has(year)) {
      holidayCache.set(year, resolveHolidays(utility.day_types ?? {}, year));
    }
    return holidayCache.get(year);
  };

  // Precompute season bounds once.
  const seasons = Object.entries(utility.seasons).map(([name, s]) => {
    const [sm, sd] = s.start.split("-").map(Number);
    const [em, ed] = s.end.split("-").map(Number);
    return { name, from: monthDayIndex(sm, sd), to: monthDayIndex(em, ed) };
  });

  return {
    seasonOf(date) {
      const i = monthDayIndex(date.getMonth() + 1, date.getDate());
      for (const s of seasons) {
        // Winter wraps the year end, so the range test flips when from > to.
        const inRange = s.from <= s.to ? i >= s.from && i <= s.to : i >= s.from || i <= s.to;
        if (inRange) return s.name;
      }
      throw new Error(`No season covers ${localDateKey(date)} — check seasons in the rate file.`);
    },

    holidayName(date) {
      return holidaysFor(date.getFullYear()).get(localDateKey(date)) ?? null;
    },

    /**
     * Tariffs price weekends and holidays identically, so both map to the
     * "weekend" rate tree. isHoliday is reported separately for display.
     */
    dayTypeOf(date) {
      const dow = date.getDay();
      if (dow === 0 || dow === 6) return "weekend";
      return this.holidayName(date) ? "weekend" : "weekday";
    },
  };
}

/**
 * Expected interval count for a local calendar day.
 *
 * Not 96. DST transition days genuinely have 23 and 25 hours, and assuming a
 * fixed count flags two legitimate days a year as incomplete.
 */
export function expectedIntervalsForDay(date, durationSeconds) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return Math.round((next - start) / 1000 / durationSeconds);
}
