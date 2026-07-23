// Page wiring. All arithmetic lives in js/ so it can be tested in Node, and
// each panel of the page lives in js/ui/. What is left here is the part that
// cannot belong to any single panel: loading the rate data, reading the user's
// file, and the one function that decides what gets re-rendered when something
// changes.

import { parseIntervals, localDateKey } from "./js/parse.js";
import { costPlan } from "./js/cost.js";
import { buildHistory } from "./js/revisions.js";
import { nemEligiblePlans } from "./js/nem.js";

import { $, esc, notice, stat, fmtDate, getJSON } from "./js/ui/dom.js";
import { state } from "./js/ui/state.js";
import {
  buildZoneSelect, buildCitySelect, buildProviderSelect, buildVintageSelect,
  buildNbtVintageSelect, syncVintageToProvider, syncNemControls, nemMode,
  currentOverlay, renderSolarDetected,
} from "./js/ui/setup.js";
import { activeIntervals, costOptions } from "./js/ui/compute.js";
import {
  renderTrimNote, renderTrueUp, renderCoverage, meterEligiblePlans, byCost,
  renderHeadline, renderTable, renderExcluded, renderRateRevisions,
  renderProvenance, renderBuildInfo, providerRows, renderProviderTable,
} from "./js/ui/results.js";
import {
  renderAddedLoad, onProfileChange, syncBatteryControls, solarYield,
} from "./js/ui/scenario-panel.js";
import { looksLikeBattery } from "./js/scenario.js";
import {
  drawPlanChart, drawShapeChart, drawMonthlyChart, drawProviderChart,
} from "./js/ui/charts.js";
import { initStepNav, syncStepNav, resetSteps, setOnReveal } from "./js/ui/steps.js";

async function init() {
  const index = await getJSON("rates/index.json");
  const docs = await Promise.all(index.files.map((f) => getJSON(`rates/${f.path}`)));

  state.utility = docs.find((d) => d.type === "utility");
  if (!state.utility) throw new Error("No utility rate file in rates/index.json.");
  state.overlays = index.files
    .map((f, i) => ({ file: f.path, doc: docs[i] }))
    .filter((o) => o.doc.type === "generation");
  state.exportTable = docs.find((d) => d.type === "export_prices") ?? null;
  state.cities = docs.find((d) => d.type === "cities") ?? null;

  // The archive manifest only — a list, not rate data. The revisions themselves
  // are fetched once a usage file says which of them the period actually needs,
  // so a household whose data sits inside the current revision downloads nothing
  // extra and the first paint is unchanged.
  try {
    state.historyIndex = (await getJSON("rates/history/index.json")).files ?? [];
  } catch {
    // No archive published. Every day then prices at the current revision, which
    // is what the calculator did before the archive existed.
    state.historyIndex = [];
  }

  buildZoneSelect();
  buildCitySelect();
  buildProviderSelect();
  buildVintageSelect();
  buildNbtVintageSelect();
  renderProvenance(index);

  await loadProfiles();

  initStepNav();
  // Opening a step is the first moment its canvases have a real size, so the
  // charts inside it have to be built then rather than while it was hidden.
  setOnReveal(() => { if (state.raw.length) recompute(); });

  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
  setupDropzone();

  for (const id of ["period", "trim", "zone", "baseline-type", "nbt-vintage", "separate-ev-meter"]) {
    $(id).addEventListener("change", recompute);
  }
  $("city").addEventListener("change", () => {
    buildProviderSelect();
    syncVintageToProvider();
    recompute();
  });
  $("provider").addEventListener("change", () => {
    syncVintageToProvider();
    recompute();
  });
  $("vintage").addEventListener("change", recompute);
  $("trueup-date").addEventListener("change", recompute);
  $("nem").addEventListener("change", () => {
    syncNemControls();
    recompute();
  });
  $("profile").addEventListener("change", onProfileChange);
  $("profile-kwh").addEventListener("input", renderAddedLoad);
  // Changing the system size re-estimates the annual kWh; editing the kWh
  // directly is treated as authoritative and is not overwritten again.
  $("solar-kw").addEventListener("input", () => {
    $("solar-kwh").value = Math.round(Number($("solar-kw").value) * solarYield());
    renderAddedLoad();
  });
  for (const id of ["solar-kwh", "scenario-cost"]) {
    $(id).addEventListener("input", renderAddedLoad);
  }
  $("battery").addEventListener("change", () => {
    syncBatteryControls();
    renderAddedLoad();
  });
  $("has-battery")?.addEventListener("change", () => {
    syncBatteryControls();
    renderAddedLoad();
  });

  // Deliberately not awaited, and deliberately last. The footer stamp is
  // cosmetic, and putting a network round trip ahead of the wiring above delays
  // the file input becoming usable for it — which is a real race, not a
  // theoretical one: it broke the step navigation in testing.
  //
  // A 404 is the normal case for a locally served copy, so a failure here just
  // leaves the source link standing alone.
  getJSON("build-info.json").then(renderBuildInfo).catch(() => {});

  // Set once every control above is wired. Nothing on the page reads it — it
  // exists so tools/browser-check.html can wait for the page to be usable
  // instead of guessing at a duration. init() makes a dozen-odd fetches before
  // reaching this line, and a fixed timer that is generous on an idle machine
  // is not generous on a busy one; the suite raced it intermittently.
  document.documentElement.dataset.ready = "true";
}

async function loadProfiles() {
  try {
    const idx = await getJSON("profiles/index.json");
    state.profiles = await Promise.all(
      idx.profiles.map(async (p) => ({ ...p, ...(await getJSON(`profiles/${p.path}`)) })),
    );
    // Generation profiles drive the solar control, not the added-load dropdown.
    // Listing solar as a "load you could add" would be the wrong sign entirely.
    for (const p of state.profiles.filter((p) => p.kind !== "generation")) {
      $("profile").insertAdjacentHTML("beforeend", `<option value="${p.id}">${esc(p.name)}</option>`);
    }
    if (!state.profiles.some((p) => p.kind === "generation")) {
      for (const id of ["solar-kw", "solar-kwh"]) $(id).closest("label").remove();
    }
  } catch {
    // A missing profile library disables step 4 but must not break the calculator.
    $("step-load").remove();
  }
}

// --- import ----------------------------------------------------------------

function setupDropzone() {
  const dz = $("dropzone");
  for (const type of ["dragenter", "dragover"]) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.add("over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.remove("over"); });
  }
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const { intervals, warnings, meta } = parseIntervals(reader.result);
      state.raw = intervals;
      state.selectedPlanId = null;
      // Pre-tick "I already have a battery" from the export pattern. Set once
      // per file rather than on every recompute, so a user who overrides the
      // guess keeps their choice for the rest of the session. A new file is a
      // new household, so it is re-guessed then.
      if ($("has-battery")) $("has-battery").checked = looksLikeBattery(intervals);
      // A different file is a different household. Collapse back to step 1 so
      // the zone, provider and solar answers get re-confirmed against it rather
      // than silently carrying over from whoever was loaded before.
      resetSteps();
      showImport(meta, warnings);
      // Before costing, since which revisions apply changes every figure below.
      await loadHistoryFor(intervals);
      recompute();
    } catch (e) {
      $("import-stats").innerHTML = "";
      $("loaded").classList.remove("hidden");
      $("period-notes").innerHTML = notice("warn", "Couldn't read that file", esc(e.message));
    }
  };
  reader.readAsText(file);
}

/**
 * Fetch the archived rate revisions this file's dates actually need.
 *
 * "Need" means: effective before the current revision, and not older than the
 * revision that already covers the file's first day. A file entirely inside the
 * current rates fetches nothing.
 *
 * Rates only ever move backwards from here — the archive can never reprice a day
 * the current file already covers, because buildTimeline resolves each day to the
 * newest revision at or before it and the current one is always newest.
 */
async function loadHistoryFor(intervals) {
  state.timeline = null;
  if (!intervals.length || !state.historyIndex.length) return;

  const from = localDateKey(intervals[0].start);

  const forUtility = state.historyIndex
    .filter((f) => f.type === "utility" && f.effective_date < state.utility.effective_date)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  // Everything effective after the file starts, plus the one that was already in
  // force when it starts — without that last one the earliest days would fall
  // back and warn for no reason.
  const covering = forUtility.filter((f) => f.effective_date > from);
  const straddling = forUtility.find((f) => f.effective_date <= from);
  const needed = straddling ? [...covering, straddling] : covering;
  if (!needed.length) return;

  const docs = await Promise.all(needed.map(async (f) => {
    if (!state.history.has(f.path)) {
      state.history.set(f.path, await getJSON(`rates/history/${f.path}`));
    }
    return state.history.get(f.path);
  }));

  state.timeline = buildHistory({
    utility: state.utility,
    utilityHistory: docs,
    from: intervals[0].start,
    to: intervals.at(-1).start,
  });
}

function showImport(meta, warnings) {
  $("loaded").classList.remove("hidden");
  $("import-stats").innerHTML =
    stat(meta.intervalCount.toLocaleString(), "intervals") +
    stat(`${Math.round(meta.totalKWh).toLocaleString()} kWh`, "total usage") +
    stat(fmtDate(meta.start), "from") +
    stat(fmtDate(meta.end), "to");
  $("period-notes").innerHTML = warnings.map((w) => notice("warn", "Note", esc(w))).join("");
}

// --- compute ---------------------------------------------------------------

function recompute() {
  if (!state.raw.length) return;

  const { intervals, dropped } = activeIntervals();
  if (!intervals.length) {
    $("period-notes").innerHTML = notice("warn", "Nothing left to cost",
      "Every day was trimmed as incomplete. Try unticking &ldquo;trim incomplete days&rdquo;.");
    return;
  }

  // Steps 2-4 are opened by their own next buttons, not by having data. Every
  // panel below still renders — into hidden sections if the user has not walked
  // that far — so revealing a step never has to wait on a recompute.
  syncStepNav();

  renderTrimNote(dropped);
  renderSolarDetected(intervals);

  const overlay = currentOverlay();
  // Under a NEM tariff most plans are simply not available, so they are dropped
  // with a reason rather than ranked as options the customer cannot take.
  const { eligible, excludedByMeter } = meterEligiblePlans(state.utility.plans);
  const { allowed, excluded } = nemEligiblePlans(nemMode(), eligible);
  excluded.push(...excludedByMeter);
  const results = [];
  for (const plan of allowed) {
    if (overlay && !overlay.doc.plans[plan.id]) continue;
    try {
      results.push(costPlan({ ...costOptions(intervals, overlay?.doc), planId: plan.id }));
    } catch {
      // A plan the rate file can't price is omitted rather than shown wrong.
    }
  }
  results.sort(byCost);
  renderExcluded(excluded);
  if (!results.length) return;

  if (!results.some((r) => r.planId === state.selectedPlanId)) {
    state.selectedPlanId = results[0].planId;
  }
  const selected = results.find((r) => r.planId === state.selectedPlanId) ?? results[0];

  renderCoverage(intervals);
  renderRateRevisions(selected);
  renderTrueUp(intervals, selected);
  renderHeadline(results, intervals);
  renderTable(results, (planId) => { state.selectedPlanId = planId; recompute(); });
  drawPlanChart(results);
  drawShapeChart(intervals);
  drawMonthlyChart(intervals);
  renderProviders(intervals);
  renderAddedLoad();
}

/**
 * The provider comparison is one costing feeding two views, so the rows are
 * built once here rather than by the table and the chart separately.
 */
function renderProviders(intervals) {
  const plan = state.utility.plans.find((p) => p.id === state.selectedPlanId);
  $("provider-chart-plan").textContent = plan ? plan.name : "";
  const rows = providerRows(intervals, state.selectedPlanId);
  renderProviderTable(rows);
  drawProviderChart(rows);
}

// --- boot ------------------------------------------------------------------

init().catch((e) => {
  $("step-import").insertAdjacentHTML(
    "beforeend",
    notice("warn", "Couldn't load rate data", `${esc(e.message)}<p>If you opened this file directly, ` +
      `serve the folder over HTTP instead — browsers block <code>fetch</code> on <code>file://</code>.</p>`),
  );
});
