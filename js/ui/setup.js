// Step 2 — the selects that describe the household, and the derived readings
// that depend on them. Everything here is a question the usage file cannot
// answer: climate zone, city, generation provider, and which solar tariff.

import { $, esc, notice } from "./dom.js";
import { state } from "./state.js";

export function buildZoneSelect() {
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
export function buildCitySelect() {
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

export const currentCity = () =>
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
export function overlaysForCity() {
  const city = currentCity();
  if (!city) return state.overlays;
  if (!city.cca) return [];
  return state.overlays.filter(
    (o) =>
      o.doc.provider === city.cca &&
      (!o.doc.rate_group || o.doc.rate_group === city.cca_rate_group),
  );
}

export function buildProviderSelect() {
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

export function buildVintageSelect() {
  const years = Object.keys(state.utility.cca_adders.pcia_by_vintage).sort();
  $("vintage").innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
  syncVintageToProvider();
}

/**
 * The rate group and the PCIA vintage travel together — a customer in SDCP's
 * 2022 group left bundled service in 2022. Defaulting the vintage from the
 * chosen product stops the two from silently disagreeing.
 */
export function syncVintageToProvider() {
  const overlay = currentOverlay();
  $("vintage-wrap").classList.toggle("hidden", !overlay);
  if (overlay?.doc.pcia_vintage) $("vintage").value = String(overlay.doc.pcia_vintage);
}

export const currentOverlay = () =>
  state.overlays.find((o) => o.file === $("provider").value) ?? null;

// --- solar -----------------------------------------------------------------

/**
 * NBT vintages, newest first. The vintage is the year the customer applied and
 * it fixes their export prices for nine years, so two customers on the same
 * plan in the same house can be paid differently for the same exported kWh.
 */
export function buildNbtVintageSelect() {
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

export const nemMode = () => $("nem").value;

export function syncNemControls() {
  $("nbt-vintage-wrap").classList.toggle("hidden", nemMode() !== "nem3");
}

/** The nem block costPlan expects, or null when there's no solar. */
export function nemOptions() {
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
export function renderSolarDetected(intervals) {
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
