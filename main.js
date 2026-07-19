// Page wiring. All arithmetic lives in src/ so it can be tested in Node;
// this file only moves data between the DOM, the engine, and Chart.js.

import { parseIntervals } from "./src/parse.js";
import { costPlan } from "./src/cost.js";
import { nemEligiblePlans } from "./src/nem.js";
import {
  selectPeriod, trimIncompleteDays, describePeriod,
  hourlyShape, monthlyTotals, applyLoadProfile,
} from "./src/period.js";

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

  buildZoneSelect();
  buildCitySelect();
  buildProviderSelect();
  buildVintageSelect();
  buildNbtVintageSelect();
  renderCaveats();
  renderProvenance(index);

  await loadProfiles();

  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
  setupDropzone();

  for (const id of ["period", "trim", "zone", "baseline-type", "nbt-vintage"]) {
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
  $("nem").addEventListener("change", () => {
    syncNemControls();
    recompute();
  });
  $("profile").addEventListener("change", onProfileChange);
  $("profile-kwh").addEventListener("input", renderAddedLoad);
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
    for (const p of state.profiles) {
      $("profile").insertAdjacentHTML("beforeend", `<option value="${p.id}">${esc(p.name)}</option>`);
    }
  } catch {
    // A missing profile library disables step 4 but must not break the calculator.
    $("step-load").remove();
  }
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
  reader.onload = () => {
    try {
      const { intervals, warnings, meta } = parseIntervals(reader.result);
      state.raw = intervals;
      state.selectedPlanId = null;
      showImport(meta, warnings);
      recompute();
    } catch (e) {
      $("import-stats").innerHTML = "";
      $("loaded").classList.remove("hidden");
      $("period-notes").innerHTML = notice("warn", "Couldn't read that file", esc(e.message));
    }
  };
  reader.readAsText(file);
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
  };
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

  renderTrimNote(dropped);

  renderSolarDetected(intervals);

  const overlay = currentOverlay();
  // Under a NEM tariff most plans are simply not available, so they are dropped
  // with a reason rather than ranked as options the customer cannot take.
  const { allowed, excluded } = nemEligiblePlans(nemMode(), state.utility.plans);
  const results = [];
  for (const plan of allowed) {
    if (overlay && !overlay.doc.plans[plan.id]) continue;
    try {
      results.push(costPlan({ ...costOptions(intervals, overlay?.doc), planId: plan.id }));
    } catch {
      // A plan the rate file can't price is omitted rather than shown wrong.
    }
  }
  results.sort((a, b) => a.total - b.total);
  renderExcluded(excluded);
  if (!results.length) return;

  if (!results.some((r) => r.planId === state.selectedPlanId)) {
    state.selectedPlanId = results[0].planId;
  }

  renderCoverage(intervals);
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
      </div>
    </div>`;
}

function renderTable(results) {
  const best = results[0].total;
  $("ranking").tBodies[0].innerHTML = results.map((r) => {
    // Export credits and non-bypassable charges ride in the adders column
    // rather than getting one each — they are zero for most people, and the
    // per-plan detail below breaks them out.
    const adders = r.lines.pcia + r.lines.stateRegulatoryFee +
      r.lines.franchiseFeeDifferential + r.lines.franchiseFeeEquivalent + r.lines.baselineCredit +
      r.lines.nonbypassable - r.lines.exportCredit;
    const delta = r.total - best;
    const cls = [r.planId === results[0].planId ? "best" : "",
                 r.planId === state.selectedPlanId ? "selected" : ""].join(" ").trim();
    return `<tr data-plan="${esc(r.planId)}" class="${cls}" tabindex="0">
      <td>${esc(r.planName)}<span class="plan-sub">${esc(r.provider)}${r.pricingModel === "tiered" ? " · tiered" : ""}${
        r.lines.exportCredit > 0 ? ` · ${money(r.lines.exportCredit)} export credit` : ""}${
        r.unusedCredit > 0 ? " · ends in credit" : ""}</span></td>
      <td class="num-col">${money(r.lines.delivery)}</td>
      <td class="num-col">${money(r.lines.generation)}</td>
      <td class="num-col">${money(r.lines.fixed)}</td>
      <td class="num-col">${money(adders)}</td>
      <td class="num-col total">${money(r.total)}</td>
      <td class="num-col delta">${delta < 0.005 ? "—" : "+" + money(delta)}</td>
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
  const reason = excluded[0].reason; // Same rule for every plan it dropped.
  const names = excluded.map((x) => esc(x.name.split("—")[0].trim())).join(", ");
  $("excluded-note").innerHTML =
    `<b>${excluded.length} plan${excluded.length === 1 ? "" : "s"} not shown.</b> ` +
    `${esc(reason)} Excluded: ${names}.`;
}

function renderCaveats() {
  const items = [
    ["Solar is modelled; the annual true-up is not",
     "NEM 2.0 nets exports against imports at retail, and NEM 3.0 credits them at SDG&E's published hourly export prices — both are implemented. What isn't: if you end the period holding credit, that is paid out at a wholesale rate that varies hourly, so a household generating more than it uses will do slightly better than shown."],
    ["Eligibility is only enforced for solar",
     "Under a solar plan the calculator drops the plans that tariff forbids. Everywhere else every plan is priced, including ones you may not qualify for. TOU-ELEC is capped at 10,000 customers, EV plans need a registered EV, and EV-TOU requires a separately metered charger — so its total is not comparable to a whole-home plan."],
    ["One rate revision per period",
     "Rates change several times a year. The calculator applies a single set to the whole period, which introduces a small error when your data spans a change."],
    ["Some fees are inferred, not published",
     "The franchise fee bases were derived from a real bill and reproduce it to the cent, but they are not stated in any tariff. Climate credits and other one-off bill credits are not included."],
  ];
  $("caveats").innerHTML = items
    .map(([t, d]) => `<div class="caveat"><b>${t}</b><p>${d}</p></div>`)
    .join("");
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

function renderAddedLoad() {
  if (!$("step-load") || !state.raw.length) return;
  const profile = state.profiles.find((p) => p.id === $("profile").value);
  if (!profile) {
    $("load-result").innerHTML = "";
    $("load-figure").classList.add("hidden");
    destroy("load");
    return;
  }

  const annual = Number($("profile-kwh").value) || 0;
  const { intervals } = activeIntervals();
  const overlay = currentOverlay();
  const withLoad = applyLoadProfile(intervals, profile, annual);

  // Rank both ways: adding a load can change which plan wins, which is the
  // most useful thing this section can tell anyone.
  const eligible = nemEligiblePlans(nemMode(), state.utility.plans).allowed;
  const rank = (series) => eligible
    .filter((p) => !overlay || overlay.doc.plans[p.id])
    .map((p) => { try { return costPlan({ ...costOptions(series, overlay?.doc), planId: p.id }); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.total - b.total);

  const before = rank(intervals);
  const after = rank(withLoad);
  const current = after.find((r) => r.planId === state.selectedPlanId) ?? after[0];
  const currentBefore = before.find((r) => r.planId === current.planId);
  const added = current.total - currentBefore.total;

  const changed = before[0].planId !== after[0].planId;
  const body = [];

  if (changed) {
    body.push(`It also changes the best plan: <strong>${esc(before[0].planName)}</strong> before, ` +
      `<strong>${esc(after[0].planName)}</strong> after.`);
  } else {
    body.push(`Best plan stays <strong>${esc(after[0].planName)}</strong> at ${money(after[0].total)}.`);
  }

  // On a tiered plan the hour of use is irrelevant — only the total matters.
  // Saying so beats letting someone conclude that timing never matters, when
  // the section directly above promises that it does.
  if (current.pricingModel === "tiered") {
    body.push(`<em>${esc(current.planName.split("—")[0].trim())} prices on total usage, not time of day, ` +
      `so this figure is the same whenever you charge. Pick a time-of-use plan in the table above ` +
      `to see what shifting the load is worth.</em>`);
  }

  $("load-result").innerHTML = notice(changed ? "warn" : "info",
    `${esc(profile.name)} adds ${money(added)} on ${esc(current.planName)}`,
    body.join(" "));

  $("load-figure").classList.remove("hidden");
  drawLoadChart(intervals, withLoad);
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
  rows.sort((a, b) => a.total - b.total);
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

  const best = rows[0].total;
  const selected = $("provider").value;
  $("provider-table").tBodies[0].innerHTML = rows.map((r) => {
    const delta = r.total - best;
    const credits = r.lines.generationCredit - r.lines.exportCredit;
    return `<tr class="${r.file === selected ? "selected" : ""}">
      <td>${esc(r.name)}<span class="plan-sub">${esc(r.sub)}</span></td>
      <td class="num-col">${r.renewablePct == null ? "—" : `${r.renewablePct}%`}</td>
      <td class="num-col">${money(r.lines.generation)}</td>
      <td class="num-col">${money(r.lines.pcia)}</td>
      <td class="num-col">${Math.abs(credits) < 0.005 ? "—" : money(credits)}</td>
      <td class="num-col total">${money(r.total)}</td>
      <td class="num-col delta">${delta < 0.005 ? "—" : "+" + money(delta)}</td>
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
