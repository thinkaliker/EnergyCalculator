// Step 4 — the counterfactual. Add a load, add panels, add a battery, and see
// what the same year would have cost.

import { $, esc, money, notice } from "./dom.js";
import { state } from "./state.js";
import { costPlan } from "../cost.js";
import { createCalendar } from "../calendar.js";
import { nemEligiblePlans } from "../nem.js";
import { applyBattery, createPriceRanker, BATTERY_SIZES } from "../scenario.js";
import { applyLoadProfile, describePeriod } from "../period.js";
import { currentOverlay, nemMode } from "./setup.js";
import { activeIntervals, costOptions } from "./compute.js";
import { byCost } from "./results.js";
import { destroy, drawLoadChart } from "./charts.js";

export const solarProfile = () => state.profiles.find((p) => p.kind === "generation") ?? null;

/** kWh per kW per year, used only to seed the output field from a system size. */
export const solarYield = () => solarProfile()?.specific_yield_kwh_per_kw ?? 1500;

export function syncBatteryControls() {
  $("battery-strategy-wrap").classList.toggle("hidden", !$("battery").value);
}

export function onProfileChange() {
  const p = state.profiles.find((x) => x.id === $("profile").value);
  if (p) {
    $("profile-kwh").value = p.annual_kwh;
    $("profile-note").textContent = p.notes ?? "";
  } else {
    $("profile-note").textContent = "";
  }
  renderAddedLoad();
}

/**
 * Build the counterfactual series.
 *
 * Order is not arbitrary. Load and solar both act on the meter independently,
 * but the battery reacts to what is left over — so it has to see the net of the
 * other two, not the original series. Running the battery first would have it
 * storing surplus that the solar had not yet produced.
 *
 * `rankAt` is plan-specific, so this is called once per plan rather than once.
 */
function buildScenario(intervals, { profile, profileKWh, solarKWh, battery, strategy, rankAt }) {
  let series = intervals;
  if (profile && profileKWh > 0) series = applyLoadProfile(series, profile, profileKWh);
  if (solarKWh > 0 && solarProfile()) series = applyLoadProfile(series, solarProfile(), solarKWh);
  if (battery && rankAt) {
    series = applyBattery(series, { ...BATTERY_SIZES[battery], strategy, rankAt }).intervals;
  }
  return series;
}

/** Whether the imported file already shows solar, which the scenario cannot model on top of. */
function fileHasSolar() {
  const { intervals } = activeIntervals();
  return intervals.some((iv) => (iv.generationKWh ?? 0) > 0);
}

export function renderAddedLoad() {
  if (!$("step-load") || !state.raw.length) return;

  const profile = state.profiles.find((p) => p.id === $("profile").value);
  const profileKWh = Number($("profile-kwh").value) || 0;
  const battery = $("battery").value || null;
  const strategy = $("battery-strategy").value;
  let solarKWh = Number($("solar-kwh").value) || 0;

  // Once panels exist, self-consumed production never crosses the meter, so the
  // file no longer records whole-house load — and load is exactly what a
  // production model has to be subtracted from. Adding more solar on top of a
  // baseline we cannot see would be guesswork dressed as arithmetic.
  const hasSolar = fileHasSolar();
  if ($("solar-kw")) {
    $("solar-kw").disabled = hasSolar;
    $("solar-kwh").disabled = hasSolar;
  }
  if (hasSolar) solarKWh = 0;

  $("scenario-note").innerHTML = hasSolar
    ? notice("info", "You already have solar, so “add solar” is switched off",
        "This file records what crossed the meter, and once panels are on the roof the energy " +
        "they supply directly to the house never does. There is no way to recover what your " +
        "whole-house load would have been, so modelling a second array on top of it would be a " +
        "guess. A battery still works — it acts on the import and export the meter did record.")
    : "";

  const nothingChanged = !(profile && profileKWh > 0) && solarKWh <= 0 && !battery;
  if (nothingChanged) {
    $("load-result").innerHTML = "";
    $("load-figure").classList.add("hidden");
    destroy("load");
    return;
  }

  const { intervals } = activeIntervals();
  const overlay = currentOverlay();

  // Adding solar today means the Net Billing Tariff, whatever the household is
  // on now — and NBT puts residential customers on EV-TOU-5. So the comparison
  // is across two different tariffs, and that gets said rather than buried.
  const scenarioNem = solarKWh > 0 ? "nem3" : nemMode();
  const newSolar = solarKWh > 0 && nemMode() === "none";

  const eligible = nemEligiblePlans(scenarioNem, state.utility.plans).allowed
    .filter((p) => !overlay || overlay.doc.plans[p.id]);
  if (!eligible.length) { $("load-result").innerHTML = ""; return; }

  const nemBlock = scenarioNem === "none"
    ? null
    : { mode: scenarioNem, vintage: $("nbt-vintage").value, exportTable: state.exportTable };

  const calendar = createCalendar(state.utility);
  const scenarioFor = (plan) => {
    let rankAt = null;
    if (battery) {
      // A tiered plan has no hourly curve to schedule against. Skip the battery
      // for it rather than dropping the plan — the rest of the scenario is still
      // meaningful there.
      try { rankAt = createPriceRanker({ plan, overlay: overlay?.doc, calendar }); } catch { rankAt = null; }
    }
    return buildScenario(intervals, { profile, profileKWh, solarKWh, battery, strategy, rankAt });
  };

  const results = [];
  for (const plan of eligible) {
    try {
      const series = scenarioFor(plan);
      const after = costPlan({ ...costOptions(series, overlay?.doc), planId: plan.id, nem: nemBlock });
      const before = costPlan({ ...costOptions(intervals, overlay?.doc), planId: plan.id });
      results.push({ plan, before, after, series });
    } catch { /* plan cannot be priced under the scenario */ }
  }
  if (!results.length) { $("load-result").innerHTML = ""; return; }

  results.sort((a, b) => byCost(a.after, b.after));
  const baseline = [...results].sort((a, b) => byCost(a.before, b.before))[0];
  const best = results[0];
  const delta = best.after.total - baseline.before.total;

  const bits = [];
  bits.push(describeScenario(profile, profileKWh, solarKWh, battery, strategy));
  bits.push(`Best plan today is <strong>${esc(baseline.before.planName)}</strong> at ` +
    `${money(baseline.before.total)}; afterwards it is <strong>${esc(best.after.planName)}</strong> ` +
    `at ${money(best.after.total)}.`);

  if (newSolar) {
    bits.push("<em>Solar moves you onto the Net Billing Tariff, which requires EV-TOU-5 — " +
      "so this compares two different tariffs, not two versions of the same one.</em>");
  }
  if (battery) {
    bits.push("<em>The battery is scheduled by a simple rule with no weather or price forecast, " +
      "so a real system managed by its installer should do somewhat better than this.</em>");
  }

  const cost = Number($("scenario-cost").value);
  if (cost > 0) {
    const period = describePeriod(intervals, state.utility);
    const perYear = (-delta) * (365 / Math.max(period.dayCount, 1));
    bits.push(perYear > 0
      ? `At ${money(perYear)} saved a year, ${money(cost)} pays back in ` +
        `<strong>${(cost / perYear).toFixed(1)} years</strong> before any tax credit.`
      : `This scenario does not lower the bill, so there is no payback to compute.`);
  }

  $("load-result").innerHTML = notice(delta < 0 ? "good" : "warn",
    delta < 0
      ? `Your bill drops ${money(-delta)} over this period`
      : `Your bill rises ${money(delta)} over this period`,
    bits.join(" "));

  $("load-figure").classList.remove("hidden");
  drawLoadChart(intervals, best.series);
}

function describeScenario(profile, profileKWh, solarKWh, battery, strategy) {
  const parts = [];
  if (profile && profileKWh > 0) parts.push(`${esc(profile.name.toLowerCase())} at ${profileKWh.toLocaleString()} kWh/yr`);
  if (solarKWh > 0) parts.push(`${solarKWh.toLocaleString()} kWh/yr of solar`);
  if (battery) {
    parts.push(`a ${BATTERY_SIZES[battery].capacityKWh} kWh battery ` +
      (strategy === "grid" ? "charged off-peak" : "storing your own solar"));
  }
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : parts[0];
  return `Modelling ${list}.`;
}
