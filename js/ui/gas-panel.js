// Step 4 — gas charges and fuel switching. Show the current gas bill from a few
// therms inputs, then answer three "swap this gas appliance for an electric
// one" questions.
//
// Reports in $/year, which the rest of the calculator never does (see the
// caveat in index.html). Gas therms are entered as annual figures — there is no
// gas usage file to trim a period from — so the electric side is annualized to
// match, using the same 365/dayCount scaling scenario-panel.js uses for payback.

import { $, esc, money, notice } from "./dom.js";
import { state } from "./state.js";
import { costPlan } from "../cost.js";
import { applyLoadProfile, describePeriod } from "../period.js";
import { distributeTherms, costGasYear, gasSavingsFromRemoving } from "../gas-cost.js";
import { currentOverlay } from "./setup.js";
import { activeIntervals, costOptions } from "./compute.js";
import { explainLoadTiming } from "../explain.js";

// The three swappable appliances plus the non-swappable "other" bucket. Field
// ids are kept in one place so main.js can wire them without re-deriving them.
export const GAS_THERMS_FIELD = {
  stove: "gas-stove-therms",
  heating: "gas-heating-therms",
  "water-heater": "gas-water-heater-therms",
  other: "gas-other-therms",
};
export const GAS_KWH_FIELD = {
  stove: "gas-stove-kwh",
  heating: "gas-heating-kwh",
  "water-heater": "gas-water-heater-kwh",
};
const SWAP_CARD = {
  stove: "gas-swap-stove",
  heating: "gas-swap-heating",
  "water-heater": "gas-swap-water-heater",
};
export const GAS_SWAPPABLE = ["stove", "heating", "water-heater"];

const appliance = (id) => state.gasAppliances.find((a) => a.id === id);

/** The electric kWh a swap adds, derived from the therms it removes. Heating and
 *  water heating use a stated efficiency ratio (furnace/tank efficiency over a
 *  heat-pump COP); the stove has no such ratio and falls back to its
 *  replacement profile's own default. */
function electricReplacementKWh(a, annualTherms) {
  if (a.conversion) {
    const { therm_to_kwh, gas_efficiency, electric_efficiency } = a.conversion;
    return (annualTherms * therm_to_kwh * gas_efficiency) / electric_efficiency;
  }
  return state.profiles.find((p) => p.id === a.electric_replacement_profile)?.annual_kwh ?? 0;
}

/** Back to defaults on a new file: therms from the manifest, kWh re-derived from
 *  them. The following recompute renders the results. */
export function resetGasPanel() {
  if (!$("step-gas")) return;
  for (const a of state.gasAppliances) {
    const f = $(GAS_THERMS_FIELD[a.id]);
    if (f) f.value = a.annual_therms;
  }
  for (const id of GAS_SWAPPABLE) {
    const a = appliance(id);
    const f = $(GAS_KWH_FIELD[id]);
    if (a && f) f.value = Math.round(electricReplacementKWh(a, a.annual_therms));
  }
}

/**
 * A therms input changed: re-derive that appliance's default electric kWh from
 * it, then re-render. The kWh field is written *only* here — renderGasPanel
 * reads it but never overwrites it — so a user who edits the kWh directly keeps
 * their value, the same rule solar-kwh follows against solar-kw.
 */
export function onGasThermsChange(id) {
  const a = appliance(id);
  const kwhField = $(GAS_KWH_FIELD[id]);
  if (a && kwhField) {
    kwhField.value = Math.round(electricReplacementKWh(a, Number($(GAS_THERMS_FIELD[id]).value) || 0));
  }
  renderGasPanel();
}

export function renderGasPanel() {
  if (!$("step-gas") || !state.raw.length || !state.gasUtility) return;

  // Monthly therms per appliance, then summed to a household total. A real gas
  // meter tiers the *combined* monthly usage, not each end use on its own, so
  // the sum is what gets priced.
  const monthlyByAppliance = new Map();
  for (const a of state.gasAppliances) {
    monthlyByAppliance.set(a.id, distributeTherms(Number($(GAS_THERMS_FIELD[a.id]).value) || 0, a.monthly_shape));
  }
  const monthlyTotal = new Array(12).fill(0);
  for (const m of monthlyByAppliance.values()) {
    for (let i = 0; i < 12; i++) monthlyTotal[i] += m[i];
  }

  const currentBill = costGasYear({ gasUtility: state.gasUtility, monthlyTherms: monthlyTotal });
  $("gas-current-bill").innerHTML = notice("info",
    `Your gas bill is about ${money(currentBill.total)} a year`,
    "Priced from the therms above the way your meter bills them — a baseline tier and an " +
    "above-baseline tier, not a flat average rate. Small per-therm surcharges and the semi-annual " +
    "climate credit are not included, so a real bill runs a little different.");

  const { intervals } = activeIntervals();
  const overlay = currentOverlay();
  const period = describePeriod(intervals, state.utility);
  const perYear = (d) => d * (365 / Math.max(period.dayCount, 1));
  const planName = state.utility.plans.find((p) => p.id === state.selectedPlanId)?.name ?? "";

  for (const id of GAS_SWAPPABLE) {
    const a = appliance(id);
    if (!a || !$(SWAP_CARD[id])) continue;

    // Gas side: the annual $ removing just this appliance's therms saves, tiered
    // against the remaining household usage month by month.
    const gasSaved = gasSavingsFromRemoving({
      gasUtility: state.gasUtility,
      monthlyThermsTotal: monthlyTotal,
      applianceMonthlyTherms: monthlyByAppliance.get(id),
    });

    // Electric side: what the replacement load adds to the currently-selected
    // plan, costed with the same before/after machinery Step 5 uses, then
    // annualized to line up with the gas figure.
    const profile = state.profiles.find((p) => p.id === a.electric_replacement_profile);
    const kWh = Number($(GAS_KWH_FIELD[id]).value) || 0;
    let electricAdded = 0;
    if (profile && kWh > 0 && state.selectedPlanId) {
      try {
        const before = costPlan({ ...costOptions(intervals, overlay?.doc), planId: state.selectedPlanId });
        const after = costPlan({ ...costOptions(applyLoadProfile(intervals, profile, kWh), overlay?.doc), planId: state.selectedPlanId });
        electricAdded = perYear(after.total - before.total);
      } catch {
        // A plan the scenario can't price leaves the electric side at zero
        // rather than breaking the card.
        electricAdded = 0;
      }
    }

    const net = electricAdded - gasSaved;
    const selectedPlan = state.utility.plans.find((p) => p.id === state.selectedPlanId);
    const timing = explainLoadTiming(profile, selectedPlan, intervals);
    $(SWAP_CARD[id]).innerHTML = notice(net < 0 ? "good" : "warn",
      net < 0 ? `Saves about ${money(-net)} a year` : `Costs about ${money(net)} a year more`,
      `Dropping the ${esc(a.name.toLowerCase())} cuts your gas bill by ${money(gasSaved)} a year. ` +
      `Running a ${esc(profile?.name.toLowerCase() ?? "replacement")} at ${kWh.toLocaleString()} kWh/yr ` +
      `on <strong>${esc(planName)}</strong> adds about ${money(electricAdded)} a year to your electric bill ` +
      `(scaled from your ${period.dayCount}-day file to a full year).` +
      (timing ? ` ${esc(timing)}` : ""));
  }
}
