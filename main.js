// Page wiring. All arithmetic lives in src/ so it can be tested in Node;
// this file only moves data between the DOM, the engine, and Chart.js.

import { parseIntervals, localDateKey } from "./src/parse.js";
import { costPlan } from "./src/cost.js";
import { buildHistory } from "./src/revisions.js";
import { nemEligiblePlans } from "./src/nem.js";
import { applyBattery, createPriceRanker, BATTERY_SIZES } from "./src/scenario.js";
import { createCalendar } from "./src/calendar.js";
import {
  selectPeriod, trimIncompleteDays, describePeriod,
  hourlyShape, monthlyTotals, applyLoadProfile, relevantPeriods,
} from "./src/period.js";
import { trueUp } from "./src/trueup.js";

const $ = (id) => document.getElementById(id);
const money = (n) => `$${n.toFixed(2)}`;
const charts = {};

const state = {
  utility: null,
  overlays: [],      // { file, doc }
  exportTable: null, // NEM 3.0 export prices; absent means NEM 3.0 is unavailable
  cities: null,      // city -> CCA membership and franchise fee
  profiles: [],
  raw: [],           // every interval in the file
  selectedPlanId: null,
  historyIndex: [],  // past rate revisions available, as { provider, effective_date, path }
  history: new Map(),// path -> fetched revision document
  timeline: null,    // resolver over the revisions this file's dates need
};

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
  renderCaveats();
  renderProvenance(index);

  await loadProfiles();

  initStepNav();

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
  $("battery-strategy").addEventListener("change", renderAddedLoad);
}

const getJSON = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

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
    if (!solarProfile()) {
      for (const id of ["solar-kw", "solar-kwh"]) $(id).closest("label").remove();
    }
  } catch {
    // A missing profile library disables step 4 but must not break the calculator.
    $("step-load").remove();
  }
}

const solarProfile = () => state.profiles.find((p) => p.kind === "generation") ?? null;

/** kWh per kW per year, used only to seed the output field from a system size. */
const solarYield = () => solarProfile()?.specific_yield_kwh_per_kw ?? 1500;

function syncBatteryControls() {
  $("battery-strategy-wrap").classList.toggle("hidden", !$("battery").value);
}

// --- selects ---------------------------------------------------------------

function buildZoneSelect() {
  const zones = Object.keys(state.utility.baseline.climate_zones);
  $("zone").innerHTML = zones
    .map((z) => `<option value="${z}">${z[0].toUpperCase() + z.slice(1)}</option>`)
    .join("");
}

/**
 * City drives two things that are otherwise easy to get wrong: the franchise fee
 * percentage, and which CCA — and for SDCP, which of its two rate schedules —
 * actually serves the address. Picking the wrong SDCP schedule gets both the
 * generation price and the PCIA vintage wrong, so it is better derived from the
 * city than left to the user.
 */
function buildCitySelect() {
  if (!state.cities) {
    $("city").closest("label").classList.add("hidden");
    return;
  }
  $("city").innerHTML = state.cities.cities
    .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`)
    .join("");
  // Nothing in the file identifies the customer's city, so there is no better
  // default than the largest one. The note under the select says what it implies.
  $("city").value = "San Diego";
}

const currentCity = () =>
  state.cities?.cities.find((c) => c.name === $("city").value) ?? null;

/** A city's total franchise fee: the territory-wide base plus its differential. */
function franchiseFeePct() {
  const ff = state.cities?.franchise_fee;
  if (!ff) return null;
  return ff.base_pct + (ff.differentials_pct?.[$("city").value] ?? 0);
}

function renderCityNote() {
  const city = currentCity();
  const pct = franchiseFeePct();
  if (!city) return;
  const cca = city.cca
    ? `${city.cca.toUpperCase()} serves this city${city.cca_rate_group ? ` (${city.cca_rate_group} rates)` : ""}.`
    : "No community choice provider serves this city.";
  $("city-note").textContent =
    `${cca} Franchise fee ${pct.toFixed(2)}%.` +
    (city.name === "San Diego" ? " San Diego is the only city with a differential." : "");
}

/**
 * The overlays a household in the selected city can actually buy. Both the
 * provider picker and the provider comparison read from this, so the table can
 * never offer a product the picker won't let you select.
 */
function overlaysForCity() {
  const city = currentCity();
  if (!city) return state.overlays;
  if (!city.cca) return [];
  return state.overlays.filter(
    (o) =>
      o.doc.provider === city.cca &&
      (!o.doc.rate_group || o.doc.rate_group === city.cca_rate_group),
  );
}

function buildProviderSelect() {
  const opts = [`<option value="">SDG&E (bundled)</option>`];
  // Only the CCA that actually serves this city, and only its rate group. A
  // customer can always opt out to SDG&E, so bundled stays available.
  // Group by provider so a CCA's several products sit together.
  const byProvider = new Map();
  for (const o of overlaysForCity()) {
    if (!byProvider.has(o.doc.provider)) byProvider.set(o.doc.provider, []);
    byProvider.get(o.doc.provider).push(o);
  }
  for (const [provider, list] of byProvider) {
    const label = provider.toUpperCase();
    opts.push(`<optgroup label="${esc(label)}">`);
    for (const o of list) {
      const area = o.doc.rate_group ? ` — ${shortArea(o.doc)}` : "";
      opts.push(`<option value="${esc(o.file)}">${esc(o.doc.product ?? provider)}${esc(area)}</option>`);
    }
    opts.push(`</optgroup>`);
  }
  $("provider").innerHTML = opts.join("");
  renderCityNote();
}

// SDCP's service_area strings are long; the first city plus a count reads better
// in a dropdown than the full list.
function shortArea(doc) {
  if (!doc.service_area) return doc.rate_group;
  const parts = doc.service_area.split(/,| and /).map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} +${parts.length - 1}` : parts[0];
}

function buildVintageSelect() {
  const years = Object.keys(state.utility.cca_adders.pcia_by_vintage).sort();
  $("vintage").innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
  syncVintageToProvider();
}

/**
 * The rate group and the PCIA vintage travel together — a customer in SDCP's
 * 2022 group left bundled service in 2022. Defaulting the vintage from the
 * chosen product stops the two from silently disagreeing.
 */
function syncVintageToProvider() {
  const overlay = currentOverlay();
  $("vintage-wrap").classList.toggle("hidden", !overlay);
  if (overlay?.doc.pcia_vintage) $("vintage").value = String(overlay.doc.pcia_vintage);
}

const currentOverlay = () => state.overlays.find((o) => o.file === $("provider").value) ?? null;

// --- solar -----------------------------------------------------------------

/**
 * NBT vintages, newest first. The vintage is the year the customer applied and
 * it fixes their export prices for nine years, so two customers on the same
 * plan in the same house can be paid differently for the same exported kWh.
 */
function buildNbtVintageSelect() {
  const table = state.exportTable;
  if (!table) {
    // No export price file means NEM 3.0 cannot be costed at all. Better to
    // remove the option than to offer one that silently prices exports at zero.
    $("nem").querySelector('option[value="nem3"]')?.remove();
    return;
  }
  const label = (v) =>
    v === "NBT00" ? "No locked-in vintage" : `Applied in 20${v.slice(3)}`;
  $("nbt-vintage").innerHTML = Object.keys(table.vintages)
    .sort()
    .reverse()
    .map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`)
    .join("");
}

const nemMode = () => $("nem").value;

function syncNemControls() {
  $("nbt-vintage-wrap").classList.toggle("hidden", nemMode() !== "nem3");
}

/** The nem block costPlan expects, or null when there's no solar. */
function nemOptions() {
  const mode = nemMode();
  if (mode === "none") return null;
  return { mode, vintage: $("nbt-vintage").value, exportTable: state.exportTable };
}

/**
 * The meter records exported energy separately, so we can tell that a household
 * has solar — but not which tariff it is on, because that depends on the
 * interconnection date. Say what we know and ask for the rest; do not guess a
 * version, because guessing wrong changes the answer substantially.
 */
function renderSolarDetected(intervals) {
  const exported = intervals.reduce((s, iv) => s + (iv.generationKWh ?? 0), 0);
  const el = $("solar-detected");

  if (exported > 0 && nemMode() === "none") {
    el.innerHTML = notice("info", "This file shows exported energy — you have solar",
      `${Math.round(exported).toLocaleString()} kWh went back to the grid over this period. ` +
      "Pick your plan below: which one you're on depends on when your system was connected, " +
      "which the file doesn't record. Until then these totals ignore your solar entirely.");
  } else if (exported === 0 && nemMode() !== "none") {
    el.innerHTML = notice("warn", "No exported energy in this file",
      "A solar plan is selected but nothing in this export went back to the grid. Either the " +
      "download didn't include the export channel or this account has no solar — either way the " +
      "totals below are not a solar bill.");
  } else {
    el.innerHTML = "";
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
  const to = localDateKey(intervals.at(-1).start);

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

/** The intervals actually being costed, after trimming and period selection. */
function activeIntervals() {
  let out = state.raw;
  let dropped = [];
  if ($("trim").checked) ({ intervals: out, dropped } = trimIncompleteDays(out));
  out = selectPeriod(out, $("period").value);
  return { intervals: out, dropped };
}

function costOptions(intervals, overlayDoc) {
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
function trueUpDate(intervals) {
  const entered = $("trueup-date").value;
  if (entered) {
    const [y, m, d] = entered.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  if (!intervals.length) return null;
  const first = intervals[0].start;
  return new Date(first.getFullYear() + 1, first.getMonth(), first.getDate());
}

function recompute() {
  if (!state.raw.length) return;

  const { intervals, dropped } = activeIntervals();
  if (!intervals.length) {
    $("period-notes").innerHTML = notice("warn", "Nothing left to cost",
      "Every day was trimmed as incomplete. Try unticking &ldquo;trim incomplete days&rdquo;.");
    return;
  }

  $("step-setup").classList.remove("hidden");
  $("step-results").classList.remove("hidden");
  $("step-load")?.classList.remove("hidden");
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

  renderCoverage(intervals);
  renderRateRevisions(results.find((r) => r.planId === state.selectedPlanId) ?? results[0]);
  renderTrueUp(intervals, results.find((r) => r.planId === state.selectedPlanId) ?? results[0]);
  renderHeadline(results, intervals);
  renderTable(results);
  drawPlanChart(results);
  drawShapeChart(intervals);
  drawMonthlyChart(intervals);
  drawProviderChart(intervals);
  renderAddedLoad();
}

// --- rendering -------------------------------------------------------------

function renderTrimNote(dropped) {
  if (!dropped.length) { $("period-notes").innerHTML = ""; return; }
  const list = dropped.slice(0, 3).map((d) => `${d.date} (${d.got}/${d.expected})`).join(", ");
  $("period-notes").innerHTML = notice("info", `Trimmed ${dropped.length} incomplete day${dropped.length === 1 ? "" : "s"}`,
    `${esc(list)}${dropped.length > 3 ? `, and ${dropped.length - 3} more` : ""}.`);
}

/**
 * The annual true-up, for NEM 2.0 households only.
 *
 * Two outcomes are reported and they are deliberately kept apart, because
 * conflating them is the mistake this section exists to correct: the dollar
 * credit balance is forfeited at the anniversary, while compensation depends
 * only on whether the year exported more kilowatt-hours than it imported.
 * Schedule NEM-ST SC 3(h): "If a customer has not generated excess kWhs, the
 * customer is not eligible for NSC."
 */
function renderTrueUp(intervals, result) {
  const wrap = $("trueup");
  const show = nemMode() === "nem2" && intervals.length > 0;
  $("trueup-wrap").classList.toggle("hidden", nemMode() !== "nem2");
  wrap.classList.toggle("hidden", !show);
  if (!show) return;

  const date = trueUpDate(intervals);
  const inferred = !$("trueup-date").value;
  $("trueup-date-note").innerHTML = inferred
    ? `Guessed from your file. Your bill prints the real one &mdash; ` +
      `&ldquo;your NEM service will true-up on&nbsp;&hellip;&rdquo;.`
    : `Set from your bill.`;
  $("trueup-date-note").classList.toggle("inferred", inferred);

  const periods = relevantPeriods(intervals[0].start, intervals.at(-1).start, date);
  const period = periods.at(-1);
  const t = trueUp({ intervals, period, ledger: result.ledger });

  const kwh = (n) => `${Math.round(n).toLocaleString()} kWh`;
  const partial = !t.complete
    ? ` Your file covers only part of this period, so this is where the year stands so far, ` +
      `not a settled result.`
    : "";

  $("trueup-outcome").innerHTML = t.netKWh < 0
    ? `Between ${fmtDate(t.start)} and ${fmtDate(t.trueUp)} you exported ` +
      `${kwh(-t.netKWh)} more than you imported.` +
      (t.eligibleForNSC
        ? ` That surplus qualifies for Net Surplus Compensation.`
        : ` A full twelve months has to end that way to qualify for Net Surplus Compensation.`) +
      partial
    : `Between ${fmtDate(t.start)} and ${fmtDate(t.trueUp)} you imported ` +
      `${kwh(t.netKWh)} more than you exported, so no compensation is due — ` +
      `it is decided on kilowatt-hours, not on any credit balance.` + partial;

  $("trueup-ledger").tBodies[0].innerHTML = t.months.map((m) => `<tr${m.trueUp ? ` class="trueup-row"` : ""}>
      <td>${esc(m.month)}${m.trueUp ? " <span class=\"tag\">true-up</span>" : ""}</td>
      <td class="num-col">${Math.round(m.netKWh).toLocaleString()}</td>
      <td class="num-col">${money(m.energyDollars)}</td>
      <td class="num-col">${m.cumulativeBalance < 0 ? money(-m.cumulativeBalance) + " cr" : money(m.cumulativeBalance)}</td>
    </tr>`).join("");

  const forfeit = t.forfeitedCredit;
  $("trueup-note").innerHTML =
    (forfeit > 0.005
      ? `${money(forfeit)} of credit is standing at the true-up date. It is not paid out — ` +
        `Schedule NEM-ST SC 3 hands it to the utility. `
      : "") +
    `Net Surplus Compensation is paid on surplus kilowatt-hours at a rate SDG&amp;E sets ` +
    `monthly &mdash; a rolling twelve-month average of wholesale DLAP prices from 7am to 5pm, ` +
    `published at sdge.com/nem. This calculator does not fetch it, so no dollar figure for the ` +
    `payout is shown.`;
}

/**
 * Seasonal pricing means a partial year ranks plans differently than a full
 * year would, so a short period gets a visible warning naming the missing
 * seasons rather than a quietly confident number.
 */
function renderCoverage(intervals) {
  const p = describePeriod(intervals, state.utility);
  if (p.spansFullYear) {
    $("coverage-warning").innerHTML = notice("good", "Full year of data",
      `Costing ${p.dayCount} days — seasonal pricing is fully represented.`);
    return;
  }
  const missing = p.missingSeasons.length
    ? ` No <strong>${p.missingSeasons.join(" or ")}</strong> usage is represented, and ` +
      `${p.missingSeasons.includes("summer") ? "summer peak rates dominate the annual answer" : "winter rates differ substantially"}.`
    : "";
  $("coverage-warning").innerHTML = notice("warn",
    `Based on ${p.dayCount} days, not a full year`,
    `Covering ${esc(p.seasons.join(" and "))}.${missing} Rankings from a partial year can differ from a full one.`);
}

/**
 * Drop the plans that need their own meter, unless the user says they have one.
 *
 * These are not merely hard to qualify for — they are priced against the wrong
 * data. A whole-home export is the house meter, and EV-TOU serves a second meter
 * carrying only the charger, so costing the house's kWh on it answers a question
 * nobody asked. It also happens to produce the cheapest total on the table for a
 * net exporter, since it is the one schedule with no Base Services Charge, which
 * is the worst possible place for a plausible wrong answer to appear.
 *
 * The flag lives in the rate file rather than as an id check here, so a schedule
 * that adds or drops the requirement is a data edit.
 */
function meterEligiblePlans(plans) {
  if ($("separate-ev-meter").checked) return { eligible: plans, excludedByMeter: [] };
  const eligible = [];
  const excludedByMeter = [];
  for (const plan of plans) {
    if (plan.eligibility?.separate_meter_required) {
      excludedByMeter.push({
        id: plan.id,
        name: plan.name,
        reason: "This plan serves a separately metered EV charger, so it cannot be priced " +
          "against a whole-home usage file. Tick “separately metered EV charger” above if you have one.",
      });
    } else {
      eligible.push(plan);
    }
  }
  return { eligible, excludedByMeter };
}

/**
 * Cheapest first — but a household that exports more than it imports floors at
 * $0 on several plans at once, and then the totals say nothing. Break that tie
 * on the credit left over at the end of the period, because that is the only
 * thing still separating them.
 *
 * The credit is deliberately NOT folded into the total. It settles at a
 * wholesale Net Surplus rate worth a fraction of retail, so $500 of leftover
 * credit is nothing like $500 of savings; it ranks the zeroes and no more.
 */
const byCost = (a, b) => a.total - b.total || b.unusedCredit - a.unusedCredit;

/** True for every row tied with the winner on both keys, so ties keep the star. */
const isBest = (r, best) =>
  r.total - best.total < 0.005 && Math.abs(r.unusedCredit - best.unusedCredit) < 0.005;

/**
 * Wire each step's "next" button to scroll to the step it names. The buttons
 * live in the markup so the pairing is visible there rather than in a table
 * here, and each one hides itself whenever its target is missing or still
 * hidden — offering to jump to results before a file is loaded would advertise
 * a step that has nothing in it.
 */
function initStepNav() {
  for (const btn of document.querySelectorAll("[data-next]")) {
    btn.addEventListener("click", () => {
      const target = $(btn.dataset.next);
      if (!target || target.classList.contains("hidden")) return;
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
      // Move focus too, or a keyboard user gets scrolled somewhere their next
      // Tab doesn't continue from.
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  }
  syncStepNav();
}

function syncStepNav() {
  for (const btn of document.querySelectorAll("[data-next]")) {
    const target = $(btn.dataset.next);
    const ready = target && !target.classList.contains("hidden");
    btn.closest(".step-nav").classList.toggle("hidden", !ready);
  }
}

function renderHeadline(results, intervals) {
  const best = results[0];
  const p = describePeriod(intervals, state.utility);
  const worst = results.at(-1);
  const spread = worst.total - best.total;
  $("headline").innerHTML = `
    <div class="headline">
      <div class="big">${esc(best.planName)} — ${money(best.total)}</div>
      <div class="sub">
        Cheapest of ${results.length} plan${results.length === 1 ? "" : "s"} on
        ${esc(best.provider)} for ${esc(p.label)}.
        ${spread > 0.005 ? `Switching to the most expensive would cost ${money(spread)} more.` : ""}
        ${best.unusedCredit > 0.005
          && best.total - (best.lines.fixed + best.lines.nonbypassable) < 0.005
          ? `You export more than you import, so generation credits cancel everything they are ` +
            `allowed to and the bill lands on the Base Services Charge plus the non-bypassable ` +
            `charges on the power you did import, neither of which credits can offset. ` +
            `Several plans tie there, so the ranking falls back to the credit left over — ` +
            `${money(best.unusedCredit)} here, which the utility keeps at your true-up date. ` +
            `Whether you are paid anything depends on kilowatt-hours, not on that balance.`
          : ""}
      </div>
    </div>`;
}

/**
 * "vs best" normally reads in dollars. When both rows floor at $0 that column
 * would be a row of dashes hiding a real difference, so it falls back to the
 * credit gap — worded as credit, never as money, since the two do not settle at
 * the same rate.
 */
function deltaCell(r, best, delta) {
  if (delta >= 0.005) return "+" + money(delta);
  const creditGap = best.unusedCredit - r.unusedCredit;
  if (creditGap < 0.005) return "—";
  return `<span class="credit-gap">${money(creditGap)} less credit</span>`;
}

function renderTable(results) {
  const best = results[0];
  $("ranking").tBodies[0].innerHTML = results.map((r) => {
    // Export credits and non-bypassable charges ride in the adders column
    // rather than getting one each — they are zero for most people, and the
    // per-plan detail below breaks them out.
    const adders = r.lines.pcia + r.lines.stateRegulatoryFee +
      r.lines.franchiseFeeDifferential + r.lines.franchiseFeeEquivalent + r.lines.baselineCredit +
      r.lines.nonbypassable - r.lines.exportCredit;
    const delta = r.total - best.total;
    // Tie on the numbers, not on position: two plans a fraction of a cent apart
    // are both the cheapest answer, and marking only the first implies a
    // precision the rates don't have.
    const cls = [isBest(r, best) ? "best" : "",
                 r.planId === state.selectedPlanId ? "selected" : ""].join(" ").trim();
    return `<tr data-plan="${esc(r.planId)}" class="${cls}" tabindex="0">
      <td>${esc(r.planName)}<span class="plan-sub">${esc(r.provider)}${r.pricingModel === "tiered" ? " · tiered" : ""}${
        r.lines.exportCredit > 0 ? ` · ${money(r.lines.exportCredit)} export credit` : ""}${
        r.unusedCredit > 0.005 ? ` · ${money(r.unusedCredit)} credit forfeited at true-up` : ""}</span></td>
      <td class="num-col">${money(r.lines.delivery)}</td>
      <td class="num-col">${money(r.lines.generation)}</td>
      <td class="num-col">${money(r.lines.fixed)}</td>
      <td class="num-col">${money(adders)}</td>
      <td class="num-col total">${money(r.total)}</td>
      <td class="num-col delta">${deltaCell(r, best, delta)}</td>
    </tr>`;
  }).join("");

  for (const tr of $("ranking").tBodies[0].rows) {
    const pick = () => { state.selectedPlanId = tr.dataset.plan; recompute(); };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  }
}

/**
 * Say which plans were left out and why. A silently shorter table reads as "these
 * are your options"; under NEM 3.0 that would be one row with no explanation.
 */
function renderExcluded(excluded) {
  if (!excluded.length) { $("excluded-note").innerHTML = ""; return; }
  // Plans can now be dropped by two independent rules at once — a NEM tariff and
  // the separate-meter gate — so the reasons are grouped rather than assuming
  // one rule explains every missing row.
  const byReason = new Map();
  for (const x of excluded) {
    byReason.set(x.reason, [...(byReason.get(x.reason) ?? []), x.name.split("—")[0].trim()]);
  }
  const parts = [...byReason].map(([reason, names]) =>
    `${esc(reason)} Excluded: ${names.map(esc).join(", ")}.`);
  $("excluded-note").innerHTML =
    `<b>${excluded.length} plan${excluded.length === 1 ? "" : "s"} not shown.</b> ${parts.join(" ")}`;
}

function renderCaveats() {
  const items = [
    ["Solar and the true-up are modelled; the payout rate is not",
     "NEM 2.0 nets exports against imports at retail, NEM 3.0 credits them at SDG&E's published hourly export prices, and for NEM 2.0 the annual true-up is worked out too: the credit standing at your anniversary is kept by the utility, and whether you are paid anything turns on kilowatt-hours, not on that balance — export more kWh than you import across the twelve months and the surplus earns Net Surplus Compensation, otherwise nothing is due no matter how much credit you banked. What isn't modelled is the rate that surplus is paid at. SDG&E resets it monthly from a rolling average of wholesale prices, so a household with genuine surplus does slightly better than shown."],
    ["What-if scenarios are modelled, not quoted",
     "The solar curve is a clear-sky model for a generic south-facing San Diego roof — it knows the sun's position exactly and knows nothing about weather, your roof's angle, or the tree next to it. That is why the annual output is yours to enter: put the number from a real quote in and only the shape is being assumed. The battery is scheduled by a simple rule that reacts to today's prices with no forecast, so a real system managed by its installer should beat what's shown here. Payback is arithmetic on the numbers you supplied and includes no tax credit, rebate, financing or degradation."],
    ["Eligibility is only enforced where the price would be meaningless",
     "Two rules are enforced: a solar tariff drops the plans it forbids, and EV-TOU is hidden unless you say you have a separately metered charger, because it prices a meter your usage file does not describe. Everything else is priced whether or not you qualify — TOU-ELEC is capped at 10,000 customers, and the EV plans need a registered EV."],
    ["EV-TOU is priced as one meter, and it is really two",
     "If you tick the separately metered charger box, EV-TOU is costed by running your whole-home file through it. That is not what such a bill looks like: the house sits on a whole-home schedule and only the charger sits on EV-TOU, so a real customer gets two sets of charges. Splitting them means guessing how much of your usage was charging, which the file does not record. Nothing here has been checked against an actual EV-TOU bill. Treat its total as a rough single-meter approximation, not a quote — and note it is also the only residential schedule with no Base Services Charge, which flatters it against every other plan."],
    ["One rate revision per period",
     "Rates change several times a year. The calculator applies a single set to the whole period, which introduces a small error when your data spans a change."],
    ["Some fees are inferred, not published",
     "The franchise fee bases were derived from a real bill and reproduce it to the cent, but they are not stated in any tariff. Climate credits and other one-off bill credits are not included."],
  ];
  $("caveats").innerHTML = items
    .map(([t, d]) => `<div class="caveat"><b>${t}</b><p>${d}</p></div>`)
    .join("");
}

/**
 * Which rate revisions produced the figures on screen.
 *
 * Shown whenever more than one applied, because that is the case where a single
 * "rates effective X" line at the bottom of the page would be a lie — the period
 * was priced at two or three different sets of rates, and the reader is entitled
 * to know which.
 *
 * A revision not yet checked by a person is called out separately. Its numbers
 * are used in full, so the point is not to discount the figure but to say how
 * far it has been verified.
 */
function renderRateRevisions(result) {
  const el = $("rate-revisions");
  if (!el) return;
  const used = result?.provenance?.revisions ?? [];
  if (used.length < 2) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  const dates = [...used].sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  const unreviewed = result.provenance.unreviewed;
  el.classList.remove("hidden");
  el.innerHTML =
    `<h3>Priced at ${dates.length} rate revisions</h3>` +
    `<p>Your data spans a rate change, so each day is charged at the rates that were in force ` +
    `on it — the same way the bill does it.</p>` +
    `<ul class="revision-list">${dates.map((r) => {
      const flagged = unreviewed.includes(r.effective_date);
      return `<li>Effective ${esc(r.effective_date)}` +
        (flagged ? ` <span class="tag unverified">not human-verified</span>` : "") +
        `</li>`;
    }).join("")}</ul>` +
    (unreviewed.length
      ? `<p class="unverified-note">Revisions marked <strong>not human-verified</strong> were ` +
        `extracted automatically and cross-checked against a real bill, but nobody has read them ` +
        `against the tariff yet. Their numbers are used in full — this is a statement about how ` +
        `far they have been checked, not a discount applied to them.</p>`
      : "");
}

function renderProvenance(index) {
  const u = state.utility;
  $("rate-provenance").innerHTML =
    `Rates effective ${esc(u.effective_date)} · ${index.files.length} rate files · ` +
    `manifest generated ${esc(index.generated)}.`;
}

// --- added load ------------------------------------------------------------

function onProfileChange() {
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

function renderAddedLoad() {
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

// --- charts ----------------------------------------------------------------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function destroy(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function baseOptions(extra = {}) {
  const grid = css("--line");
  const text = css("--text-dim");
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    ...(extra.indexAxis ? { indexAxis: extra.indexAxis } : {}),
    plugins: {
      legend: { labels: { color: text, boxWidth: 12, font: { size: 11 } } },
      ...extra.plugins,
    },
    scales: {
      x: { grid: { color: grid }, ticks: { color: text, font: { size: 11 } }, ...extra.x },
      y: { grid: { color: grid }, ticks: { color: text, font: { size: 11 } }, ...extra.y },
    },
  };
}

// Shades the 4-9pm on-peak window behind the load-shape charts, so it is
// visually obvious whether usage lands in the expensive hours.
const peakBand = {
  id: "peakBand",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    const x1 = scales.x.getPixelForValue(16);
    const x2 = scales.x.getPixelForValue(20);
    ctx.save();
    ctx.fillStyle = css("--peak");
    ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
    ctx.restore();
  },
};

function drawPlanChart(results) {
  destroy("plans");
  const parts = [
    ["Delivery", "--delivery", (r) => r.lines.delivery],
    ["Generation", "--generation", (r) => r.lines.generation],
    ["Fixed", "--fixed", (r) => r.lines.fixed],
    ["Adders & credits", "--adders", (r) => r.lines.pcia + r.lines.stateRegulatoryFee +
      r.lines.franchiseFeeDifferential + r.lines.franchiseFeeEquivalent + r.lines.baselineCredit],
  ];
  charts.plans = new Chart($("chart-plans"), {
    type: "bar",
    data: {
      labels: results.map((r) => r.planId),
      datasets: parts.map(([label, color, get]) => ({
        label, data: results.map(get), backgroundColor: css(color), borderWidth: 0,
      })),
    },
    options: baseOptions({
      x: { stacked: true },
      y: { stacked: true, ticks: { callback: (v) => `$${v}` } },
    }),
  });
}

function drawShapeChart(intervals) {
  destroy("shape");
  charts.shape = new Chart($("chart-shape"), {
    type: "line",
    data: {
      labels: [...Array(24).keys()],
      datasets: [{
        label: "Average kWh",
        data: hourlyShape(intervals),
        borderColor: css("--accent"),
        backgroundColor: css("--accent-soft"),
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
      }],
    },
    options: baseOptions({
      plugins: { legend: { display: false } },
      x: { ticks: { callback: (v) => `${v}:00`, maxTicksLimit: 8 } },
    }),
    plugins: [peakBand],
  });
}

function drawMonthlyChart(intervals) {
  destroy("monthly");
  const months = monthlyTotals(intervals);
  charts.monthly = new Chart($("chart-monthly"), {
    type: "bar",
    data: {
      labels: months.map(([m]) => m),
      datasets: [{
        label: "kWh",
        data: months.map(([, v]) => v),
        backgroundColor: css("--delivery"),
        borderWidth: 0,
      }],
    },
    options: baseOptions({ plugins: { legend: { display: false } } }),
  });
}

/**
 * The same plan across every provider that serves it. This is the comparison
 * the site exists for, and it only makes sense one plan at a time — different
 * plans have different delivery, so mixing them hides the generation story.
 *
 * Each overlay is costed on its own PCIA vintage, because the vintage travels
 * with the rate group; costing them all on the picker's vintage would make two
 * rate groups look like they differ in generation when they differ in exit fee.
 */
function providerRows(intervals, planId) {
  const rows = [];
  try {
    rows.push({
      name: "SDG&E",
      sub: "bundled generation",
      file: "",
      ...costPlan({ ...costOptions(intervals, null), planId }),
    });
  } catch { /* plan unpriceable; skip */ }

  for (const o of overlaysForCity()) {
    if (!o.doc.plans[planId]) continue;
    try {
      const opts = costOptions(intervals, o.doc);
      opts.pciaVintage = o.doc.pcia_vintage ?? opts.pciaVintage;
      rows.push({
        name: `${o.doc.provider.toUpperCase()} ${o.doc.product}`,
        sub: providerSub(o.doc),
        file: o.file,
        renewablePct: o.doc.renewable_content_pct ?? null,
        ...costPlan({ ...opts, planId }),
      });
    } catch { /* provider doesn't serve this plan */ }
  }
  rows.sort(byCost);
  return rows;
}

/** The things that distinguish one CCA product from another, in one line. */
function providerSub(doc) {
  const bits = [];
  if (doc.renewable_content_pct != null) bits.push(`${doc.renewable_content_pct}% renewable`);
  if (doc.generation_credit_per_kwh) bits.push("includes a temporary credit");
  if (doc.rate_group) bits.push(`${doc.rate_group} rates`);
  return bits.join(" · ");
}

/**
 * Providers side by side for the selected plan. The bar chart shows the spread;
 * this shows why it exists, since the totals differ by a couple of dollars while
 * the renewable content differs by half.
 */
function renderProviderTable(rows) {
  const wrap = $("provider-table-wrap");
  const plan = state.utility.plans.find((p) => p.id === state.selectedPlanId);
  $("provider-table-plan").textContent = plan ? plan.name : "";

  // One provider is not a comparison — hide the whole block rather than show a
  // table whose only row is a "vs cheapest" of zero.
  wrap.classList.toggle("hidden", rows.length < 2);
  if (rows.length < 2) return;

  const best = rows[0];
  const selected = $("provider").value;
  $("provider-table").tBodies[0].innerHTML = rows.map((r) => {
    const delta = r.total - best.total;
    const credits = r.lines.generationCredit - r.lines.exportCredit;
    // Rows arrive sorted, so the first is the cheapest — but tie on the numbers
    // rather than on position, or two providers a fraction of a cent apart would
    // have one crowned and the other silently not.
    const cls = [isBest(r, best) ? "best" : "", r.file === selected ? "selected" : ""]
      .join(" ").trim();
    return `<tr class="${cls}">
      <td>${esc(r.name)}<span class="plan-sub">${esc(r.sub)}${
        r.unusedCredit > 0.005 ? ` · ${money(r.unusedCredit)} credit forfeited at true-up` : ""}</span></td>
      <td class="num-col">${r.renewablePct == null ? "—" : `${r.renewablePct}%`}</td>
      <td class="num-col">${money(r.lines.generation)}</td>
      <td class="num-col">${money(r.lines.pcia)}</td>
      <td class="num-col">${Math.abs(credits) < 0.005 ? "—" : money(credits)}</td>
      <td class="num-col total">${money(r.total)}</td>
      <td class="num-col delta">${deltaCell(r, best, delta)}</td>
    </tr>`;
  }).join("");
}

function drawProviderChart(intervals) {
  destroy("providers");
  const planId = state.selectedPlanId;
  const plan = state.utility.plans.find((p) => p.id === planId);
  $("provider-chart-plan").textContent = plan ? plan.name : "";

  const rows = providerRows(intervals, planId);
  renderProviderTable(rows);

  charts.providers = new Chart($("chart-providers"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{
        label: "Total",
        data: rows.map((r) => r.total),
        backgroundColor: rows.map((r, i) => (i === 0 ? css("--good") : css("--delivery"))),
        borderWidth: 0,
      }],
    },
    // indexAxis must be set at construction — assigning it afterwards leaves
    // the scales configured for a vertical bar and renders nothing.
    options: baseOptions({
      indexAxis: "y",
      plugins: { legend: { display: false } },
      x: { ticks: { callback: (v) => `$${v}` } },
      y: { ticks: { font: { size: 10 }, autoSkip: false } },
    }),
  });
}

function drawLoadChart(before, after) {
  destroy("load");
  charts.load = new Chart($("chart-load"), {
    type: "line",
    data: {
      labels: [...Array(24).keys()],
      datasets: [
        { label: "Now", data: hourlyShape(before), borderColor: css("--text-dim"),
          borderDash: [4, 4], pointRadius: 0, borderWidth: 2, tension: 0.3 },
        { label: "With added load", data: hourlyShape(after), borderColor: css("--generation"),
          backgroundColor: css("--warn-soft"), fill: true, pointRadius: 0, borderWidth: 2, tension: 0.3 },
      ],
    },
    options: baseOptions({ x: { ticks: { callback: (v) => `${v}:00`, maxTicksLimit: 8 } } }),
    plugins: [peakBand],
  });
}

// --- helpers ---------------------------------------------------------------

const stat = (value, label) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
const notice = (kind, title, body) => `<div class="notice ${kind}"><strong>${title}</strong><p>${body}</p></div>`;
const fmtDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- boot ------------------------------------------------------------------
// Called last on purpose. The helpers above are `const` arrows, so invoking
// init() any earlier in the module hits the temporal dead zone and fails with
// a misleading "cannot access before initialization".

init().catch((e) => {
  $("step-import").insertAdjacentHTML(
    "beforeend",
    notice("warn", "Couldn't load rate data", `${esc(e.message)}<p>If you opened this file directly, ` +
      `serve the folder over HTTP instead — browsers block <code>fetch</code> on <code>file://</code>.</p>`),
  );
});
