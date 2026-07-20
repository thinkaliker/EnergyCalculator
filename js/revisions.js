// Resolving which revision of a rate document was in force on a given day.
//
// Rates change three or four times a year. A billing period that spans a change
// is billed at both — the reference bill in rates/VALIDATION.md prints it
// outright, "Rate 1" for 4 days at delivery $0.32682 and "Rate 2" for the
// remaining 25 at $0.31711. A calculator holding one revision per provider
// cannot reproduce that, and the error it makes is invisible: every line looks
// plausible and the total is quietly wrong.
//
// WHY A TIMELINE RATHER THAN A LOOKUP: the caller does not ask "which revision
// covers this period" — no single revision does. It asks, per day, "which one
// covers this day", and the answer changes underneath a single billing month.
//
// RESOLUTION IS PER DAY, never finer. A tariff takes effect on a date boundary,
// so an hourly resolver would offer precision the source documents do not have.
//
// WHAT THIS DOES NOT DO: fetch anything. It is handed the documents it resolves
// over, so it runs identically in the browser and in tools/verify.mjs.

import { localDateKey } from "./parse.js";

/**
 * Build a per-day revision resolver over one document family.
 *
 * A "family" is one provider's one product — the SDG&E utility file and its
 * older revisions, or one CCA overlay and its older revisions. Families are
 * resolved separately because their revision dates do not line up: SDG&E
 * changed on 2026-06-01 and SDCP on 2026-05-01.
 *
 * @param {object}   o.current   the newest revision; also the fallback
 * @param {object[]} [o.history] older revisions, any order
 * @param {Date}     [o.from]    first day of the data being costed
 * @param {Date}     [o.to]      last day, used only to describe the gap
 * @returns {{ revisionAt: (d: Date) => object, revisions: object[], warnings: string[] }}
 */
export function buildTimeline({ current, history = [], from = null, to = null }) {
  if (!current?.effective_date) {
    throw new Error("buildTimeline needs a current document with an effective_date.");
  }

  // Newest first, so resolution is a scan for the first revision at or before
  // the day in question. Six revisions is the realistic ceiling, so a linear
  // scan is the right shape — a binary search here would be harder to read for
  // no measurable gain.
  // `humanReviewed` rides along on every revision because it is a property of
  // the document, not of the run. A file that has been extracted and
  // cross-checked but not yet read by a person is used at full weight — the
  // numbers are the best available — but anything computed from it has to be
  // able to say so. Absent means reviewed: the current files predate the flag
  // and were reviewed the old way.
  const revisions = [current, ...history]
    .map((doc) => ({
      id: doc.effective_date,
      effective_date: doc.effective_date,
      humanReviewed: doc.human_reviewed !== false,
      doc,
    }))
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date));

  const duplicate = revisions.find((r, i) => i > 0 && r.effective_date === revisions[i - 1].effective_date);
  if (duplicate) {
    // Two documents claiming the same day makes resolution depend on sort
    // stability, which is not a thing to leave to chance in a billing engine.
    throw new Error(`Two revisions share effective_date ${duplicate.effective_date}.`);
  }

  const oldest = revisions.at(-1);
  const warnings = [];

  // The gap is reported at build time rather than on first miss, so it reaches
  // the user even when the uncovered days happen to carry no usage.
  if (from && localDateKey(from) < oldest.effective_date) {
    const span = to ? `${localDateKey(from)} to ${localDateKey(to)}` : `before ${oldest.effective_date}`;
    warnings.push(
      `Rates for ${describe(current)} are archived back to ${oldest.effective_date}. ` +
        `Usage from ${span} that predates it is priced at the ${oldest.effective_date} revision, ` +
        `so charges for those days are approximate.`,
    );
  }

  const cache = new Map();

  const revisionAt = (date) => {
    const day = localDateKey(date);
    const hit = cache.get(day);
    if (hit) return hit;
    // Falling back to `oldest` rather than throwing is deliberate and is the
    // policy the whole archive rests on: a partly-backfilled archive stays
    // usable, and the substitution is named in `warnings` above rather than
    // being silent.
    const found = revisions.find((r) => day >= r.effective_date) ?? oldest;
    cache.set(day, found);
    return found;
  };

  return { revisionAt, revisions, warnings };
}

const describe = (doc) =>
  [doc.provider?.toUpperCase(), doc.product].filter(Boolean).join(" ") || "this provider";

/**
 * Build both timelines a costing needs, or nothing at all.
 *
 * Returns null when there is no history to apply, which is the signal `costPlan`
 * uses to take its original code path unchanged. "No archive" and "an archive of
 * one" must not be different code paths — that is what keeps the feature opt-in
 * and the existing reference bills bit-identical.
 */
export function buildHistory({ utility, utilityHistory = [], overlay = null, overlayHistory = [], from, to }) {
  if (!utilityHistory.length && !overlayHistory.length) return null;

  const util = buildTimeline({ current: utility, history: utilityHistory, from, to });
  const over = overlay
    ? buildTimeline({ current: overlay, history: overlayHistory, from, to })
    : null;

  return {
    utilityAt: util.revisionAt,
    overlayAt: over?.revisionAt ?? null,
    revisions: util.revisions,
    overlayRevisions: over?.revisions ?? [],
    warnings: [...util.warnings, ...(over?.warnings ?? [])],
  };
}

/**
 * Which revisions a costing actually drew on, and whether a person has checked
 * them.
 *
 * Structured rather than a warning string, because the UI marks the figures
 * themselves — a sentence in a list of warnings is too easy to scroll past when
 * the number beside it looks authoritative.
 */
export function revisionProvenance(timeline, usedIds) {
  if (!timeline) return { revisions: [], unreviewed: [] };
  const used = timeline.revisions.filter((r) => usedIds.has(r.id));
  return {
    revisions: used.map(({ id, effective_date, humanReviewed }) => ({ id, effective_date, humanReviewed })),
    unreviewed: used.filter((r) => !r.humanReviewed).map((r) => r.effective_date),
  };
}
