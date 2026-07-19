---
name: rate-extractor
description: >
  Extract utility and CCA rate information from a tariff PDF or rate webpage into the
  EnergyCalculator rate JSON schema, then validate and reindex. Run occasionally, by hand,
  when rates change. Use when the user says "extract rates", "update rates", "scrape the
  tariff", "add a rate file", "rates changed", or invokes /rate-extractor.
---

Turn a published tariff into a rate JSON file for `rates/`. Offline authoring tool — never runs in the deployed page.

Output is a **draft for human review**, not a commit. A wrong tariff number produces a confident wrong answer in the calculator, which is worse than no calculator.

## Before starting

Read `references/schema.md` — the canonical output shape. Prices are always `$/kWh`.

Ask which is being extracted if unclear:
- **base utility** (delivery + fixed + baseline + adders + its own generation) → `rates/<utility>.json`
- **CCA generation overlay** (generation only) → `rates/cca-<provider>.json`

Get the base utility file right first. CCA plan ids must match it.

## Extraction

PDF and webpage are separate paths. Don't share logic between them.

**SDG&E schedules — fetch them directly.** Don't hand-download, and don't use the copies scattered under `sdge.com/sites/default/files/` — those are older revisions and will silently give you stale prices.

```bash
node .claude/skills/rate-extractor/scripts/fetch-tariff.mjs list
node .claude/skills/rate-extractor/scripts/fetch-tariff.mjs get 898 /tmp/tou-dr1.pdf
pdftotext -layout /tmp/tou-dr1.pdf -
```

`list [rateGroup] [section]` — rate groups are `"Residential Rates"` (default), `"Miscellaneous"`, `"Commercial/Industrial Rates"`, `"Lighting Rates"`, `"Commodity Rates"`. Sections are `scheds` (default), `rules`, `prelim`, `toc`, `forms`, `cd`, `gas` — pass `-` for the rate group when listing a non-schedule section.

Useful keys: TOU-DR1 `898`, TOU-DR2 `899`, EV-TOU-5 `930`, TOU-ELEC `1065`, DR `8` (holds the baseline allowance table), CCA-CRS `339` (PCIA vintages), CCA `340` (franchise fee equivalent), E-PUC `53` (state regulatory fee), NBT `1064` (NEM 3.0), Territory map `187`.

Requires `pdftotext` (`brew install poppler`).

**PDF.** Read it directly. Tariff PDFs put the rate table across multiple sheets with the season/day-type legend on a different page than the numbers — read enough of the document to place each number, not just the table page. Note sheet number and revision date for `verified_against`.

**Webpage.** WebFetch it. Rate pages often render the table from JS or link out to a PDF; if the numbers aren't in the fetched HTML, follow to the PDF and use the PDF path instead. Do not infer a number from surrounding prose.

For both, capture per rate: plan, season, day type, hour window, price, and the published unit.

## Units

Read the unit off the source every time. `$/kWh`, `¢/kWh`, `$/MWh` all appear in tariff documents, sometimes in the same PDF.

- `¢/kWh` → ÷ 100
- `$/MWh` → ÷ 1000

Getting this wrong is a 100x or 1000x error that still looks like a plausible JSON file. The validator warns on out-of-band prices; treat a warning as "re-read the source", never as "widen the band".

## Not every plan is time-of-use

Check before you start tiling hours. A residential schedule may price by **cumulative consumption** against the baseline allowance instead of by clock hour — SDG&E's DR is the default residential schedule and works this way. Its table reads "Up to 130% of Baseline / Above 130% of Baseline" with no time periods anywhere in the document.

Set `pricing_model: "tiered"` and use the tier shape in `references/schema.md`. Forcing a tiered plan into hour blocks means picking one tier's price and applying it around the clock, which is wrong by the tier spread — for DR that's a 47% error on delivery.

Also check whether the baseline credit is already **inside** the tier-1 price. If the schedule has no separate credit row but its rate breakdown shows a credit component, adding `baseline.credit_per_kwh` on top double-counts it.

## Hour blocks

For time-of-use plans. Blocks must tile 0–24 with no gap and no overlap, per season and day type. A gap silently under-bills — the validator rejects it.

Tariffs describe windows in prose ("4pm to 9pm weekdays") and leave the remaining hours implicit as off-peak. Write the implicit hours out explicitly.

Windows that wrap midnight split into two blocks: `21→24` and `0→6`.

Watch for **super-off-peak**, which often applies only in one season or only on weekends. Missing it makes a plan look worse than it is.

## Validate

```bash
node .claude/skills/rate-extractor/scripts/validate.mjs rates
node .claude/skills/rate-extractor/scripts/reindex.mjs rates
```

Validate first. `reindex.mjs` only checks the fields it copies into the manifest — it is not a substitute for `validate.mjs` and will happily index a file with unpriced hours.

Fix every ERROR. For each WARN, state in your summary why it's acceptable or what you re-checked.

Passing validation means structurally sound, **not** correct. It cannot tell whether the numbers match the tariff.

## Report back

Never present output as verified. Report:

- what was extracted, from which document and revision
- source unit and any conversion applied
- validator result, with each warning explained
- **numbers you were unsure of, and why** — ambiguous table cells, footnoted adjustments, values that appear in more than one place

That last item is the point of the review step. Flag uncertainty rather than picking the likelier reading silently.

## Don't

- Don't commit. Leave the file for review.
- Don't fill gaps by interpolating between known prices.
- Don't restate delivery or adders in a CCA overlay — generation only.
- Don't hand-edit `rates/index.json`; regenerate it.
- Don't invent a zip-to-climate-zone mapping. SDG&E publishes none — zones come from a raster map with no zips on it, and v1 has the user pick their zone directly.
