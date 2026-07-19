# EnergyCalculator

Compare SDG&E and San Diego CCA electricity plans against your own Green Button usage data.

Static site, no backend — all calculation runs client-side, so your usage data never leaves your browser. See [DESIGN.md](DESIGN.md) for the full design.

## Rates

Rate data lives in `rates/` as JSON:

| File | Contents |
| --- | --- |
| `index.json` | Manifest of every rate file. Generated — never hand-edit. |
| `sdge.json` | Base utility: delivery, fixed charges, baseline, CCA adders, SDG&E generation. |
| `cca-sdcp-<vintage>-*.json` | San Diego Community Power generation, one file per rate group × product. |
| `cca-cea-*.json` | Clean Energy Alliance generation, one file per product. |
| `nbt-export.json` | NEM 3.0 export prices by vintage, year, month, day type and hour. Generated — never hand-edit. |
| `cities.json` | City → CCA membership and franchise fee percentage. |

Only the **generation** component differs between providers. CCA files never restate delivery — SDG&E delivers the power either way.

Two things drive the file count. CCAs sell several products (SDCP's PowerBase / PowerOn / Power100, CEA's Clean Impact / Clean Impact Plus / Green Impact), and SDCP additionally publishes **two different rate schedules** split by enrollment year — one for San Diego, Chula Vista, Encinitas, Imperial Beach and La Mesa (`2021v`), another for National City and the unincorporated county (`2022v`). Same product, different prices. That enrollment year is also the customer's PCIA vintage, so picking the wrong group gets both the generation rate and the exit fee wrong.

## Updating rates

Rates change several times a year. Updating them is a manual, reviewed step — a wrong tariff number produces a confident wrong answer, which is worse than no calculator.

### With Claude Code

The `rate-extractor` skill reads a tariff PDF or rate webpage and produces a rate JSON:

```text
/rate-extractor
```

Then point it at the source, e.g. *"extract TOU-DR1 from https://…/tou-dr1.pdf"*. It extracts, validates, regenerates the manifest, and reports back what it was unsure about.

**Its output is a draft.** Review the numbers against the source before committing — that review is the whole safeguard, and passing validation does not mean the numbers are right.

### Manually

The scripts run standalone; no dependencies, Node 18+. PDF extraction needs `pdftotext` (`brew install poppler`).

```bash
# List SDG&E schedules and their tarfKey
node .claude/skills/rate-extractor/scripts/fetch-tariff.mjs list
node .claude/skills/rate-extractor/scripts/fetch-tariff.mjs list Miscellaneous

# Download one as PDF (898 = TOU-DR1, 339 = CCA-CRS)
node .claude/skills/rate-extractor/scripts/fetch-tariff.mjs get 898 /tmp/tou-dr1.pdf
pdftotext -layout /tmp/tou-dr1.pdf -
```

Always fetch from the tariff API rather than the loose PDFs under `sdge.com/sites/default/files/` — those are older revisions.

Solar export prices are a separate, generated file. SDG&E publishes 20 years of hourly Net Billing Tariff export rates as a MIDAS upload; this collapses them to the month × day-type × hour table the engine actually needs. Needs `unzip`. Rerun each January, when the new vintage is published:

```bash
node .claude/skills/rate-extractor/scripts/fetch-nbt-export.mjs --years 2025,2026 --out rates/nbt-export.json
```

Unlike the other extractors this one needs no review — it is a mechanical reshaping of a published file, and it fails rather than writing a partial table if any hour is missing.

The rooftop solar shape is also generated. It is a clear-sky geometric model, not measured data — only its *shape* is used, because the user supplies the annual output, so what has to be right is the distribution across months and hours rather than the magnitude. Regenerate only if changing location or array orientation:

```bash
node .claude/skills/rate-extractor/scripts/build-solar-shape.mjs \
  --lat 32.75 --lon -117.15 --tilt 20 --out profiles/solar-rooftop.json
```

It prints the monthly distribution and the peak clock hour per month. Sanity check: the peak must sit an hour later in summer than in winter, because the clock moves and the sun does not.

```bash
# Check every rate file for structural problems
node .claude/skills/rate-extractor/scripts/validate.mjs rates

# Profiles have their own shape rules
node .claude/skills/rate-extractor/scripts/validate.mjs profiles

# Regenerate rates/index.json from what's on disk
node .claude/skills/rate-extractor/scripts/reindex.mjs rates
```

Run `validate.mjs` first. `reindex.mjs` only checks the fields it copies into the manifest — it will happily index a file with unpriced hours.

Fix every `ERROR`. Treat each `WARN` as "go re-read the source", not as a threshold to widen:

```text
WARN  sdge.json: plans.tou-dr1.delivery.summer.weekend[0]: price_per_kwh 28.5
      outside plausible $/kWh band (0.01-1.5) — check source units (¢/kWh? $/MWh?)
ERROR sdge.json: plans.tou-dr1.delivery.summer.weekday: gap in hour coverage,
      14:00-16:00 unpriced
```

Those two are the expensive ones. Tariff sheets publish prices in `$/kWh`, `¢/kWh`, and `$/MWh` — sometimes in the same document — so a unit slip is a 100x or 1000x error in a file that still looks plausible. And an hour gap silently under-bills rather than failing.

Schema reference: [.claude/skills/rate-extractor/references/schema.md](.claude/skills/rate-extractor/references/schema.md)

## Running it

The page fetches `rates/` and `profiles/` at load, and browsers block `fetch` on `file://`, so it needs to be served rather than opened:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

On GitHub Pages it works as-is — no build step, no bundler, no dependencies to install. Chart.js is vendored into `vendor/` rather than loaded from a CDN, so the page makes no third-party requests and nobody outside your browser learns you visited.

## The calculation engine

`src/` holds the math, as plain ES modules that run unchanged in the browser and in Node:

| File | Contents |
| --- | --- |
| `parse.js` | Green Button CSV and ESPI XML → one normalized interval series. |
| `calendar.js` | Season, day type, and holiday resolution, driven by the rate file. |
| `cost.js` | Interval series × plan → itemized cost breakdown. |
| `nem.js` | Solar: export pricing, plan eligibility, and monthly credit carryforward. |
| `scenario.js` | Home battery dispatch, and the plan-derived price ranking it schedules against. |

`parse.js` deliberately discards the name, address, account number, and meter number the export carries. Nothing downstream needs them, and not holding them keeps them out of a stack trace or a `localStorage` dump.

Two checks guard the math:

```bash
# Unit checks — tiered pricing, DST days, holiday shifts, CCA structure
node tools/test.mjs

# Known-answer check against a real bill (file not in the repo — it has PII)
node tools/verify.mjs ~/Downloads/Electric_15_Minute_....csv
```

`verify.mjs` reconstructs a real SDG&E bill line by line from the interval data and compares against the printed figures, which are recorded in the script as plain numbers so the bill itself never enters the repo. It holds three reference bills and picks between them by content — an export channel says the file is one of the two solar accounts, and the net kWh over each bill's own window says which:

- **Non-solar**, SDCP on EV-TOU-5: **$101.32 computed against $101.25 printed**, 0.07%.
- **NEM 2.0 solar**, CEA on TOU-DR1: every line within tolerance, plus twelve monthly time-of-use splits the bill publishes itself. Those splits check season boundaries, holiday handling and the TOU windows all at once, and are a stronger test than any single dollar figure.
- **NEM 2.0 net exporter**, SDCP PowerOn on EV-TOU-5: −831 kWh over 31 days, with every delivery and generation line on the statement printing $0.00. **$34.50 computed against $34.51 printed.** This is the only one of the three that pins the credit floor, because it is the only one whose bill *is* the floor — the other two are net importers and never reach it. It is what established that credits stop at the Base Services Charge **plus** the non-bypassable charges, not at the Base Services Charge alone.

The residual is a known limitation, not noise: that billing period spans a rate revision, and the schema currently holds one revision per file. See "Deferred" in [DESIGN.md](DESIGN.md).

Run both after any change to `rates/` or `src/`. `validate.mjs` proves the rate files are *structurally* sound; only these prove the math on top of them is right.

There's a third check for the page itself. `tools/browser-check.html` loads the real `index.html` in an iframe, feeds it synthetic Green Button data, and asserts what came out — table populated and sorted, coverage warning shown, all four charts holding plotted data, switching provider changing the totals, evening EV charging costing more than overnight. Serve the repo and open it; the page title becomes `PASS` or `FAIL n`, so it can be driven headlessly:

```bash
python3 -m http.server 8000 &
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --headless --disable-gpu --virtual-time-budget=25000 \
  --dump-dom http://localhost:8000/tools/browser-check.html | grep -o 'ALL PASSED\|[0-9]* FAILED'
```

It exists because the two failures found while building the UI — a temporal-dead-zone crash on boot, and a provider chart that rendered nothing — were both invisible to the Node tests and to a glance at the page.

## Adding a load profile

`profiles/` holds hourly load shapes (EV charging, heat pump, pool pump) as JSON, listed in `profiles/index.json`. Profiles built in the page export in this same format, so a good one can be contributed back as a file with no conversion.

## Open items

Everything below is known and deliberate. Nothing here is a surprise waiting to be discovered — but several items would change the numbers, so they're listed before the ones that only change scope.

### Needs verifying — could change results

| Item | Why it matters | What would settle it |
| --- | --- | --- |
| **SDCP rates came from HTML, not PDFs** | Cloudflare blocks scripted access to `sdcommunitypower.org`, so those numbers were read out of the rate pages rather than the filed PDFs. TOU-DR1 reproduced the earlier human-reviewed figures exactly and 2022V agreed across two independent reads, but most schedules rest on a single read. | Open `Res_2021V_2026.pdf` and `Res_2022V_2026.pdf` in a browser and diff against `rates/cca-sdcp-*.json`. |
| **CEA rate-relief credit scope** | The −$0.03871/kWh credit is applied only to Clean Impact. The schedule names it for Clean Impact and prints it under the base table, but never says premium products are excluded. If it applies to all three, both premium files are that much too expensive — enough to flip the product ranking. | Ask CEA directly. Flagged in-file as `rate_relief_scope_UNVERIFIED`. |
| **Franchise fee bases are inferred** | The two *bases* — `total − PCIA − WF-NBC` for the differential, `imputed EECC + CARE surcharge` for the equivalent surcharge — reproduce real bills but appear in no tariff. The *rates* are now sourced: see below. | Confirmed against a second bill in a different city and CCA; the equivalent-surcharge base came within 2.5%. |
| **CEA's General Municipal Surcharge** | CEA charges a GMS that isn't modelled at all. Separate from the franchise fee, which is now sourced and city-driven. | A CEA bill showing a GMS line. |
| **Mid-period rate revisions** | A billing period can span a rate change; the schema holds one revision per file, so the calculator applies a single set to the whole period. This is the entire 7¢ residual in `verify.mjs` — and something larger: **TOU-DR1's midday super-off-peak window did not exist before about March 2026.** Checked against nine months of published TOU splits, everything from March on reproduces exactly and everything before misplaces ~180 kWh per month between off-peak and super-off-peak. Any analysis spanning that date is wrong for the earlier part. | Schema change: multiple dated revisions per file, split at the effective date. |
| **DR tier boundary is per season** | The 130%-of-baseline boundary is computed per season rather than once across the period. No effect today (DR's summer and winter prices are identical) and none within a single season, but it's an approximation across a June 1 boundary. | Reworking `applyTiers` to take the whole period, once a tiered plan has season-varying prices. |
| **ESPI XML parser is unverified** | Written from the spec, never run against a real SDG&E export. Unit handling (`uom 72`, `powerOfTenMultiplier`) is the risky part. Warns at runtime. | Export one as XML and run `tools/verify.mjs` on it. |
| **`verify.mjs` has no data to run against** | The reference CSV was deleted after validation, as intended — it held real PII. The bill's line items are still in the script, so the check works again as soon as any matching export is available. | A fresh Green Button export for a period with a matching bill. |
| **Holiday list is from a 2024 advice letter** | Rule 1 (AL 4375-E, Jul 2024) is the newest revision, and it omits Juneteenth — independently confirmed by bill validation. Still worth re-reading when rates next change. | Re-fetch `tarfKey 77` during the next rate update. |
| **Some prices are derived, not transcribed** | Power100 is PowerOn + $0.01; CEA's premium products are Clean Impact + $0.00100 / + $0.00750. Both relationships are published and were checked against every printed cell, but the files hold computed numbers. Marked `_notes.derived`. | Spot-check a few cells at the next rate update. |
| **Baseline Adjustment Credit base under NEM** | The solar reference bill applied the credit to 144 kWh in a month whose billable net was 156 kWh. No base we can derive reproduces 144 — not daily netting, not a baseline cap, not a mid-period rate split. The engine uses 156, so this line runs about 8% generous for solar customers (worth $1.47 on that bill). | A second solar bill, to see whether the ratio holds. |
| **NEM 3.0 has no known-answer check** | NEM 2.0 is now reconciled against a real solar bill. NEM 3.0 is not — it is covered only by unit checks and browser assertions, same category as the ESPI XML parser. | A Solar Billing Plan customer's bill. |
| **SDCP's CARE export adder looks like a typo** | Table 1 of SDCP's NBT tariff prints $0.11/kWh for residential CARE against $0.0075 for non-CARE — 15x, and larger than most retail rates. Almost certainly meant to be $0.011. Not modelled, and CARE is not modelled at all, so nothing depends on it today. | Ask SDCP. |
| **City list is San Diego County plus a catch-all** | CCA membership is sourced from SDG&E's Active CCAs page and cross-checked against each CCA's own service area. SDG&E also serves part of southern Orange County, which is folded into one "somewhere else" entry rather than enumerated — no CCA serves it and the franchise fee is the base rate. | Enumerating the Orange County cities, if anyone needs them. |
| **Load profiles are illustrative** | The six starter shapes are hand-drawn plausible curves, not measured load data. Fine for comparing timing, not for predicting a specific appliance's bill. | Real submetered data, if anyone has it. |
| **Solar shape is modelled, not measured** | `profiles/solar-rooftop.json` is a clear-sky geometric curve for a generic south-facing 20° San Diego roof, generated by `build-solar-shape.mjs`. Sun position is exact; there is no weather in it. Only the *shape* is used — the user supplies annual output — which is what makes this acceptable, since clouds mostly scale a day rather than reshape it. Known bias: San Diego's May/June marine layer is a morning effect, so those months are really more afternoon-weighted than modelled, and the modelled Jul/Dec ratio (1.84) is steeper than reality. Cross-checked against 13 months of measured export data: the morning limb and peak hour match closely. | A PVWatts TMY pull, which replaces the file with no code change. |
| **Battery dispatch is greedy, not optimal** | The scheduler sees the current price and its current charge, with no forecast. A real installer's system beats it, so savings are understated rather than overstated. It also has no degradation, standby loss, outage reserve or demand-response revenue. Worth knowing: an oversized battery can come out *worse* than a smaller one under NBT, because charge it cannot later discharge is export credit destroyed. | Comparing against a real battery owner's before/after bills. |
| **EV-TOU's minimum bill is unconfirmed** | `EV-TOU` is the one residential schedule still holding a minimum bill ($0.413/day) instead of the Base Services Charge, and SDG&E publishes no current Total Rates Table for it alongside the others. The figure came from the tariff portal during the original extraction and could not be re-confirmed on 2026-07-19. It matters because it makes EV-TOU the cheapest row for any net exporter — the only plan that escapes the $0.79343/day floor. | Re-read Sheet 64812-E on the tariff portal. |
| **Payback is arithmetic, not advice** | Simple payback divides the user's installed cost by modelled annual savings. No tax credit, rebate, financing, escalation or degradation. The federal residential credit's status changed for systems placed in service after 2025 and depends on individual tax circumstances, so it is deliberately not modelled. | Nothing — this one is a scope decision, not a gap. |

### Not implemented yet

- **The NEM annual true-up.** Credits carry month to month, but a household ending the period in credit is not paid it in cash — it gets Net Surplus Compensation at a wholesale rate that is DLAP-indexed for SDG&E and CAISO-indexed for SDCP and moves hourly. CEA publishes a flat $0.06/kWh, but applying it for one provider only would bias the comparison. The bill floors at the Base Services Charge and the surplus is reported instead, so a household that generates more than it uses does slightly better than shown.
- **Per-month minimum bill under NEM.** Applied once across the period rather than in each month, so a household that nets to nothing month after month is charged it once instead of twelve times. Only `EV-TOU` carries a minimum bill at all — every other residential schedule replaced it with the Base Services Charge, so this affects one plan that is already unsafe to rank (it is separately metered).
- **Eligibility enforcement beyond solar and the EV meter.** Two rules are enforced: a NEM tariff drops the plans it forbids, and `EV-TOU` is hidden unless the user confirms a separately metered charger (`eligibility.separate_meter_required` in the rate file). Everything else is priced regardless of whether you qualify — `TOU-ELEC` is capped at 10,000 customers, and the EV plans need a registered EV.
- **EV-TOU as a two-meter total.** Even with the checkbox ticked, EV-TOU is costed by running the whole-home file through it, which is not what that customer's bill looks like: their house is on a whole-home schedule and only the charger is on EV-TOU. Doing it properly means splitting the series — see "Splitting a two-meter household" in `DESIGN.md`. **Deliberately not built:** there is no EV-TOU bill available to check a composite against, and building an unverifiable two-plan search to replace a single-meter approximation trades a known-rough number for a confident one. Surfaced in the page's caveats instead.
- **CARE / FERA / Medical Baseline discounts.** Each schedule publishes a parallel discounted rate table. Only the discounted daily service charges are in the file.
- **Solar on top of existing solar.** The what-if refuses a file that already shows exports, because self-consumed production never crosses the meter and whole-house load can't be recovered from it. Battery scenarios still work there.
- **User-built load profiles.** The design calls for defining profiles in the page, storing them in `localStorage`, and exporting them in the repo's format. Only the shipped library is loadable today.
- **Custom date ranges.** Only "everything" and "year to date". No arbitrary start/end.
- **Annualizing.** Costs are reported for the selected period only. The design allows an explicitly labelled annual estimate; it isn't built.
- **Zip → climate zone.** Dropped from v1 on purpose — SDG&E publishes no such mapping, and the zone is printed on every bill. SDG&E's baseline calculator resolves it server-side, so a mapping could be built by querying it.
- **Climate credit and one-off credits.** The semi-annual California Climate Credit (~$49.36, Schedule GHG-ARR) and similar bill credits are not applied.
- **Rescrape automation.** Rate updates are manual. If automated, it should open a PR rather than commit — the human review step is the safeguard.

### Deliberately out of scope

Schedule `DM`/`DS`/`DT`/`DT-RV` (submetered multi-family), `DE` (utility employees), `E-SMOP` (smart meter opt-out — those customers have no interval data to import), CEA's Peak Smart Savers event rates, Solar Plus, and Battery Bonus. Recorded in `rates/sdge.json` under `notes.schedules_not_modeled` and in each CEA file.

## Status

The calculator works end to end: import, plan ranking, provider comparison, charts, added-load modelling, and both solar tariffs. SDG&E and SDCP rates are complete; CEA is loaded but its rate-relief credit scope is unconfirmed. The largest remaining gap is that no solar path has been reconciled against a real solar bill.
