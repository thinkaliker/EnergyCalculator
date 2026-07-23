// Step 4 — the counterfactual. Add a load, add panels, add a battery, and see
// what the same year would have cost.

import { $, esc, money, notice } from "./dom.js";
import { state } from "./state.js";
import { costPlan } from "../cost.js";
import { createCalendar } from "../calendar.js";
import { nemEligiblePlans } from "../nem.js";
import { applyBattery, createPriceRanker, BATTERY_SIZES, BATTERY_STRATEGIES } from "../scenario.js";
import { applyLoadProfile, describePeriod } from "../period.js";
import { currentOverlay, nemMode } from "./setup.js";
import { activeIntervals, costOptions } from "./compute.js";
import { byCost } from "./results.js";
import { destroy, drawLoadChart } from "./charts.js";

export const solarProfile = () => state.profiles.find((p) => p.kind === "generation") ?? null;

/** kWh per kW per year, used only to seed the output field from a system size. */
export const solarYield = () => solarProfile()?.specific_yield_kwh_per_kw ?? 1500;

export function syncBatteryControls() {
  const owned = $("has-battery")?.checked;
  // An owned battery is already in the meter data, so "add a battery" would be
  // modelling a second one on top of it. Disable it and drop back to None, the
  // same way "add solar" is switched off once the file shows panels.
  const sel = $("battery");
  if (sel) {
    sel.disabled = !!owned;
    if (owned) sel.value = "";
  }
}

/**
 * Return the Step-4 counterfactual to its defaults on a new file. The result
 * blocks (note, figure, chart) are cleared by the renderAddedLoad that the
 * following recompute triggers, since with every input back at its default there
 * is nothing to model. `has-battery` is deliberately left alone: readFile has
 * just re-guessed it from this file's own export pattern.
 */
export function resetScenario() {
  if (!$("step-load")) return; // step 4 is removed when no profile library loads
  $("profile").value = "";
  $("profile-kwh").value = "3000";
  $("profile-note").textContent = "";
  if ($("solar-kw")) $("solar-kw").value = "0";
  if ($("solar-kwh")) $("solar-kwh").value = "0";
  $("battery").value = "";
  $("scenario-cost").value = "";
  syncBatteryControls();
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
  const ownsBattery = $("has-battery")?.checked;
  syncBatteryControls(); // keep the disabled state in step with the checkbox
  // An owned battery is already in the data, so no hypothetical one is applied.
  const battery = ownsBattery ? null : $("battery").value || null;
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

  // Both notes can apply at once — a solar-plus-battery account like the one
  // that motivated this trips both guards. The battery half is not merely "we
  // can't add another": a hypothetical battery reacts to import and export that
  // the real battery already reshaped, so the result would be nonsense, not just
  // approximate.
  const notes = [];
  if (hasSolar) {
    notes.push(notice("info", "You already have solar, so “add solar” is switched off",
      "This file records what crossed the meter, and once panels are on the roof the energy " +
      "they supply directly to the house never does. There is no way to recover what your " +
      "whole-house load would have been, so modelling a second array on top of it would be a guess."));
  }
  if (ownsBattery) {
    notes.push(notice("info", "You already have a battery, so “add a battery” is switched off",
      "The meter recorded the net after your battery had already charged and discharged, so a " +
      "modelled battery here would be reacting to a load your real one has reshaped — the number " +
      "would be meaningless, not just approximate. Untick the box if this account has no battery."));
  }
  $("scenario-note").innerHTML = notes.join("");

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

  // Cost the whole plan list under one battery strategy (or none) and reduce it
  // to a single summary: the cheapest plan after the change, the cheapest today,
  // and the gap between them. Called once with no battery, or once per strategy
  // when there is one.
  const runScenario = (batteryStrategy) => {
    const rows = [];
    for (const plan of eligible) {
      let rankAt = null;
      if (battery) {
        // A tiered plan has no hourly curve to schedule against. Skip the battery
        // for it rather than dropping the plan — the rest of the scenario is
        // still meaningful there.
        try { rankAt = createPriceRanker({ plan, overlay: overlay?.doc, calendar }); } catch { rankAt = null; }
      }
      try {
        const series = buildScenario(intervals, { profile, profileKWh, solarKWh, battery, strategy: batteryStrategy, rankAt });
        const after = costPlan({ ...costOptions(series, overlay?.doc), planId: plan.id, nem: nemBlock });
        const before = costPlan({ ...costOptions(intervals, overlay?.doc), planId: plan.id });
        rows.push({ before, after, series });
      } catch { /* plan cannot be priced under the scenario */ }
    }
    if (!rows.length) return null;
    rows.sort((a, b) => byCost(a.after, b.after));
    const baseline = [...rows].sort((a, b) => byCost(a.before, b.before))[0];
    const best = rows[0];
    return { strategy: batteryStrategy, best, baseline, delta: best.after.total - baseline.before.total, series: best.series };
  };

  // With a battery, both strategies are costed and shown together rather than
  // hidden behind a toggle — the point of the comparison is that a household
  // rarely knows in advance which one wins for its own usage. Without a battery
  // the strategy is irrelevant, so a single run does.
  const runs = (battery ? BATTERY_STRATEGIES.map(runScenario) : [runScenario(null)]).filter(Boolean);
  if (!runs.length) { $("load-result").innerHTML = ""; return; }
  // Biggest saving (most negative delta) first; that run drives the headline,
  // the payback and the chart.
  runs.sort((a, b) => a.delta - b.delta);
  const winner = runs[0];
  const { delta, baseline } = winner;

  const period = describePeriod(intervals, state.utility);
  const cost = Number($("scenario-cost").value);
  const perYear = (d) => (-d) * (365 / Math.max(period.dayCount, 1));

  const bits = [];
  bits.push(describeScenario(profile, profileKWh, solarKWh, battery));
  bits.push(`Best plan today is <strong>${esc(baseline.before.planName)}</strong> at ` +
    `${money(baseline.before.total)}; afterwards it is <strong>${esc(winner.best.after.planName)}</strong> ` +
    `at ${money(winner.best.after.total)}.`);

  if (battery) {
    // The two strategies laid side by side. Each delta is measured against the
    // same cheapest-plan-today baseline, so the two rows are comparable.
    bits.push(
      `<span class="strategy-compare">Two ways to run it, over this period:` +
      runs
        .slice()
        .sort((a, b) => a.delta - b.delta)
        .map((r) => {
          const save = -r.delta;
          const line = save > 0.005 ? `saves ${money(save)}` : `saves nothing`;
          const win = r === winner ? " win" : "";
          return `<span class="strategy-row${win}"><b>${esc(STRATEGY_LABELS[r.strategy])}</b> — ${line}</span>`;
        })
        .join("") +
      `</span>`,
    );
    bits.push("<em>The battery is scheduled by a simple rule with no weather or price forecast, " +
      "so a real system managed by its installer should do somewhat better than this.</em>");
  }

  if (newSolar) {
    bits.push("<em>Solar moves you onto the Net Billing Tariff, which requires EV-TOU-5 — " +
      "so this compares two different tariffs, not two versions of the same one.</em>");
  }

  if (cost > 0) {
    const py = perYear(delta);
    bits.push(py > 0
      ? `At ${money(py)} saved a year on the better strategy, ${money(cost)} pays back in ` +
        `<strong>${(cost / py).toFixed(1)} years</strong> before any tax credit.`
      : `This scenario does not lower the bill, so there is no payback to compute.`);
  }

  $("load-result").innerHTML = notice(delta < 0 ? "good" : "warn",
    delta < 0
      ? `Your bill drops ${money(-delta)} over this period`
      : `Your bill rises ${money(delta)} over this period`,
    bits.join(" "));

  $("load-figure").classList.remove("hidden");
  drawLoadChart(intervals, winner.series);
}

const STRATEGY_LABELS = {
  solar: "Storing your own solar",
  grid: "Buying cheap, using at peak",
};

function describeScenario(profile, profileKWh, solarKWh, battery) {
  const parts = [];
  if (profile && profileKWh > 0) parts.push(`${esc(profile.name.toLowerCase())} at ${profileKWh.toLocaleString()} kWh/yr`);
  if (solarKWh > 0) parts.push(`${solarKWh.toLocaleString()} kWh/yr of solar`);
  // No strategy named here — both are costed and compared below.
  if (battery) parts.push(`a ${BATTERY_SIZES[battery].capacityKWh} kWh battery`);
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : parts[0];
  return `Modelling ${list}.`;
}
