// Step 3 — the ranking table, the provider comparison, and the notes that say
// what the numbers do and don't cover.
//
// `renderTable` takes an `onSelect` callback rather than importing recompute:
// clicking a row re-runs the whole page, and reaching back into main.js for
// that would make this module and main.js mutually dependent.

import { $, esc, money, notice, fmtDate } from "./dom.js";
import { state } from "./state.js";
import { costPlan } from "../cost.js";
import { describePeriod, relevantPeriods } from "../period.js";
import { trueUp } from "../trueup.js";
import { overlaysForCity, nemMode } from "./setup.js";
import { costOptions, trueUpDate } from "./compute.js";

export function renderTrimNote(dropped) {
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
export function renderTrueUp(intervals, result) {
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
export function renderCoverage(intervals) {
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
export function meterEligiblePlans(plans) {
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
export const byCost = (a, b) => a.total - b.total || b.unusedCredit - a.unusedCredit;

/** True for every row tied with the winner on both keys, so ties keep the star. */
const isBest = (r, best) =>
  r.total - best.total < 0.005 && Math.abs(r.unusedCredit - best.unusedCredit) < 0.005;

export function renderHeadline(results, intervals) {
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

export function renderTable(results, onSelect) {
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
    const pick = () => onSelect(tr.dataset.plan);
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  }
}

/**
 * Say which plans were left out and why. A silently shorter table reads as "these
 * are your options"; under NEM 3.0 that would be one row with no explanation.
 */
export function renderExcluded(excluded) {
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
export function renderRateRevisions(result) {
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

// --- providers -------------------------------------------------------------

/**
 * The same plan across every provider that serves it. This is the comparison
 * the site exists for, and it only makes sense one plan at a time — different
 * plans have different delivery, so mixing them hides the generation story.
 *
 * Each overlay is costed on its own PCIA vintage, because the vintage travels
 * with the rate group; costing them all on the picker's vintage would make two
 * rate groups look like they differ in generation when they differ in exit fee.
 */
export function providerRows(intervals, planId) {
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
export function renderProviderTable(rows) {
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

export function renderCaveats() {
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

export function renderProvenance(index) {
  const u = state.utility;
  $("rate-provenance").innerHTML =
    `Rates effective ${esc(u.effective_date)} · ${index.files.length} rate files · ` +
    `manifest generated ${esc(index.generated)}.`;
}
