// Turn the cost engine's line-item breakdown into plain-language "why this is
// cheaper" sentences — so the page answers "does it make sense to switch?"
// itself, instead of leaving the reader to feed the numbers to an AI.
//
// Pure by design: everything arrives as arguments (result objects from
// cost.js, plan objects from the rate file, the interval series). No DOM and no
// state read here, which is what makes it unit-testable and importable anywhere.

import { money } from "./ui/dom.js";
import { hourlyShape } from "./period.js";

// The cost lines worth naming, in the words a bill-payer uses rather than the
// engine's field names. franchiseFee* share a label; they're deduped by it.
const LINE_LABELS = {
  delivery: "delivery charges",
  generation: "the energy (generation) price",
  generationCredit: "the provider's temporary credit",
  fixed: "the fixed monthly charge",
  baselineCredit: "the baseline credit",
  pcia: "the exit fee (PCIA)",
  stateRegulatoryFee: "state regulatory fees",
  nonbypassable: "non-bypassable charges",
  exportCredit: "solar export credits",
  franchiseFeeDifferential: "franchise fees",
  franchiseFeeEquivalent: "franchise fees",
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shortName = (name) => String(name).split(" — ")[0];

/**
 * Signed contribution of each cost line to `other.total - winner.total`,
 * biggest first. A positive delta means `other` pays more there than `winner`,
 * i.e. that line is a reason the winner is cheaper.
 */
export function driverDiff(winner, other) {
  const wl = winner.lines ?? {};
  const ol = other.lines ?? {};
  return Object.keys(LINE_LABELS)
    .map((key) => ({ key, label: LINE_LABELS[key], delta: (ol[key] ?? 0) - (wl[key] ?? 0) }))
    .filter((d) => Math.abs(d.delta) > 0.5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// --- time-of-use shape -----------------------------------------------------

// The rate component that actually carries the time-of-use spread. On SDG&E's
// TOU schedules that is generation (delivery is flat); a tiered plan's blocks
// have no hour bounds, so this returns null for them.
function pricedBlocks(plan) {
  for (const comp of [plan?.generation, plan?.delivery]) {
    const wk = comp?.summer?.weekday;
    if (Array.isArray(wk) && wk.every((b) => typeof b.start_hour === "number")) return wk;
  }
  return null;
}

/** The priciest contiguous block on a TOU plan — its peak window — or null. */
export function peakWindow(plan) {
  const blocks = pricedBlocks(plan);
  if (!blocks || blocks.length < 2) return null;
  const max = blocks.reduce((a, b) => (b.price_per_kwh > a.price_per_kwh ? b : a));
  const min = blocks.reduce((a, b) => (b.price_per_kwh < a.price_per_kwh ? b : a));
  // No meaningful spread means it isn't really time-of-use; don't invent a peak.
  if (max.price_per_kwh - min.price_per_kwh < 0.02) return null;
  return { startHour: max.start_hour, endHour: max.end_hour };
}

const hr12 = (h) => {
  const period = h % 24 < 12 ? "am" : "pm";
  const x = h % 12 === 0 ? 12 : h % 12;
  return { x, period };
};

function fmtWindow(w) {
  const a = hr12(w.startHour);
  const b = hr12(w.endHour);
  return a.period === b.period ? `${a.x}–${b.x}${b.period}` : `${a.x}${a.period}–${b.x}${b.period}`;
}

/** Share of the household's daily use that falls inside a peak window (0–1). */
export function peakFraction(intervals, window) {
  const shape = hourlyShape(intervals);
  const total = shape.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let peak = 0;
  for (let h = window.startHour; h < window.endHour; h++) peak += shape[h] ?? 0;
  return peak / total;
}

// A profile's own shape collapsed to 24 hours, for load-timing explanations.
function profileHourly(profile) {
  if (profile?.hourly_shape) return profile.hourly_shape;
  if (profile?.monthly_shape) {
    const out = new Array(24).fill(0);
    for (const month of profile.monthly_shape) for (let h = 0; h < 24; h++) out[h] += month[h] ?? 0;
    return out;
  }
  return null;
}

// --- explanations ----------------------------------------------------------

/**
 * One sentence on why `winner` beats `other`. When the two use different
 * pricing models (TOU vs tiered) and the gap is in energy, it reaches for the
 * household's own peak concentration — the number that actually decides it.
 */
export function explainRank({ winner, other, intervals, winnerPlan, otherPlan }) {
  if (!winner || !other) return null;
  const gap = other.total - winner.total;
  if (gap < 0.5) return null;
  const lead = `${winner.planName} comes in ${money(gap)} under ${other.planName}`;

  const drivers = driverDiff(winner, other);
  if (!drivers.length) return `${lead}.`;
  const top = drivers[0];
  const most = Math.abs(top.delta) / gap > 0.6 ? "almost all of it" : "the bulk of it";

  // TOU vs tiered — explain with the peak-window fraction, the deciding number.
  const touPlan = winner.pricingModel === "tou" ? winnerPlan
    : other.pricingModel === "tou" ? otherPlan : null;
  const mixedModels = winner.pricingModel !== other.pricingModel;
  if (mixedModels && touPlan && (top.key === "generation" || top.key === "delivery")) {
    const win = peakWindow(touPlan);
    const frac = win ? peakFraction(intervals, win) : null;
    if (frac != null) {
      const pct = Math.round(frac * 100);
      const name = shortName(touPlan.name);
      return winner.pricingModel === "tou"
        ? `${lead} — only ${pct}% of your electricity is used in ${name}'s ${fmtWindow(win)} peak window, so its cheap off-peak rate wins for you.`
        : `${lead} — ${pct}% of your electricity lands in ${name}'s ${fmtWindow(win)} peak window, enough that its high peak rate loses to flat tiers.`;
    }
  }

  const phrase = {
    generationCredit: "the difference is the provider's temporary credit, not the underlying energy price",
    pcia: `${most} is the exit fee (PCIA), not the energy price`,
    nonbypassable: `${most} is non-bypassable charges, which credits can't offset`,
    fixed: "the difference is the fixed monthly charge",
    exportCredit: `${winner.planName} earns more for the energy you send back`,
    baselineCredit: "the difference is the baseline credit",
  }[top.key];
  return phrase ? `${lead} — ${phrase}.` : `${lead}, ${most} in ${top.label}.`;
}

/** A ranked, human-readable list of what separates two plans, for a disclosure. */
export function driverList(winner, other) {
  return driverDiff(winner, other)
    .slice(0, 5)
    .map((d) => ({
      label: cap(d.label),
      text: d.delta > 0 ? `${money(d.delta)} cheaper` : `${money(-d.delta)} more`,
    }));
}

/**
 * Which generation provider to buy from, in one line: the cheapest, the gap to
 * the next, the dominant driver, and the renewable trade-off the price hides.
 */
export function explainProvider(rows) {
  if (!rows || rows.length < 2) return null;
  const [best, next] = rows;
  const gap = next.total - best.total;
  const ren = best.renewablePct != null && next.renewablePct != null && next.renewablePct !== best.renewablePct
    ? ` ${next.name} is ${next.renewablePct}% renewable to ${best.name}'s ${best.renewablePct}%, so a few dollars may buy cleaner power.`
    : "";
  if (gap < 0.5) return `${best.name} and ${next.name} cost about the same.${ren}`;
  const top = driverDiff(best, next)
    .find((d) => ["generation", "pcia", "generationCredit", "exportCredit"].includes(d.key));
  const why = top ? ` The gap is mostly ${top.label}.` : "";
  return `${best.name} is the cheapest place to buy generation, ${money(gap)} under ${next.name}.${why}${ren}`;
}

/**
 * Whether an added load lands in a plan's expensive hours — the reason a
 * scenario is cheap or dear on the plan that ends up winning it.
 */
export function explainLoadTiming(profile, plan, intervals) {
  if (!profile || profile.kind === "generation" || !plan) return null;
  const win = peakWindow(plan);
  if (!win) return null;
  const hourly = profileHourly(profile);
  if (!hourly) return null;
  const total = hourly.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let peak = 0;
  for (let h = win.startHour; h < win.endHour; h++) peak += hourly[h] ?? 0;
  const pct = Math.round((peak / total) * 100);
  const name = shortName(plan.name);
  return pct <= 15
    ? `Most of this load runs outside ${name}'s ${fmtWindow(win)} peak — only ${pct}% falls in it — which is why it's cheapest there.`
    : `${pct}% of this load runs in ${name}'s ${fmtWindow(win)} peak window, so it costs more than a shape that dodges those hours.`;
}
