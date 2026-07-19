# Rate JSON schema

Canonical spec for extractor output. Matches `DESIGN.md`. If they diverge, `DESIGN.md` wins — update this file.

All prices in **dollars per kWh**, not cents, not $/MWh. Tariff documents publish in all three. Converting is the single most common extraction error — see "Units" below.

## Base utility file — `rates/<utility>.json`

```json
{
  "provider": "sdge",
  "type": "utility",
  "effective_date": "2026-06-01",
  "source_url": "https://…",
  "verified_against": "SDG&E Schedule TOU-DR1, sheet 3 of 8, revised 2026-05-14",

  "fixed_charges": {
    "daily_service_charge": 0.0,
    "minimum_bill_daily": 0.0
  },

  "baseline": {
    "climate_zones": {
      "coastal": { "summer_kwh_per_day": 0.0, "winter_kwh_per_day": 0.0 }
    },
    "credit_per_kwh": 0.0
  },

  "seasons": {
    "summer": { "start": "06-01", "end": "10-31" },
    "winter": { "start": "11-01", "end": "05-31" }
  },

  "day_types": {
    "holidays": ["2026-01-01", "2026-07-04"]
  },

  "cca_adders": {
    "pcia_per_kwh": 0.0,
    "franchise_fee_per_kwh": 0.0,
    "dwr_bond_per_kwh": 0.0
  },

  "plans": [
    {
      "id": "tou-dr1",
      "name": "TOU-DR1",
      "eligibility": { "notes": "recorded, not enforced yet", "separate_meter_required": false },
      "delivery": {
        "summer": {
          "weekday": [{ "start_hour": 0, "end_hour": 24, "price_per_kwh": 0.0 }],
          "weekend": [{ "start_hour": 0, "end_hour": 24, "price_per_kwh": 0.0 }]
        },
        "winter": {
          "weekday": [{ "start_hour": 0, "end_hour": 24, "price_per_kwh": 0.0 }],
          "weekend": [{ "start_hour": 0, "end_hour": 24, "price_per_kwh": 0.0 }]
        }
      },
      "generation": { "…same shape as delivery…" }
    }
  ]
}
```

## Generation overlay — `rates/cca-<provider>.json`

Generation only. Never restates delivery, fixed charges, or adders — CCAs don't set those.

```json
{
  "provider": "sdcp",
  "type": "generation",
  "product": "base",
  "effective_date": "2026-06-01",
  "source_url": "https://…",
  "verified_against": "SDCP residential rate sheet, 2026-06",
  "plans": {
    "tou-dr1": {
      "summer": {
        "weekday": [{ "start_hour": 0, "end_hour": 24, "price_per_kwh": 0.0 }],
        "weekend": [{ "start_hour": 0, "end_hour": 24, "price_per_kwh": 0.0 }]
      },
      "winter": { "…": {} }
    }
  }
}
```

`plans` keys **must** match `plans[].id` in the base utility file. A plan the CCA doesn't serve is omitted, not nulled.

Multiple products (base vs 100%-green) = separate files, distinguished by `product`.

Optional overlay fields:

| Field | Meaning |
| --- | --- |
| `product` | Product name, e.g. `"PowerOn"`, `"Green Impact"` |
| `rate_group` | Which published schedule this is, when a CCA publishes more than one (SDCP publishes one per enrollment vintage) |
| `service_area` | Cities/areas the rate group covers |
| `pcia_vintage` | Enrollment year, which sets the customer's PCIA vintage in `sdge.json` |
| `renewable_content_pct` | Advertised renewable content |
| `generation_credit_per_kwh` | A per-kWh credit applied on top of the published prices. **Negative.** |
| `nbt_generation_adder_per_kwh` | Paid on top of SDG&E's NEM 3.0 export price. **Positive** — it is paid to the customer. |

`generation_credit_per_kwh` exists so a temporary credit stays visible instead of being folded into the prices — folding it in makes the numbers un-checkable against the source and silently wrong once the credit lapses. The validator rejects a positive value, since that would inflate every bill.

**Where a CCA publishes several products as a base table plus flat adders, generate the derived files rather than transcribing them**, and say so in `_notes.derived`. Nine near-identical hand-typed files is nine chances at a typo.

Note the sign difference between the two credit fields. `generation_credit_per_kwh` reduces what the customer is charged and is stored negative; `nbt_generation_adder_per_kwh` increases what they are paid for exports and is stored positive. The validator enforces both, because a sign slip in either direction produces a plausible-looking bill.

`eligibility.notes` is recorded for humans and not enforced. `eligibility.separate_meter_required` **is** enforced: the calculator hides the plan unless the user confirms the second meter exists. Set it only where the schedule serves a meter other than the whole-home one — today that is `EV-TOU` alone. It is not a "hard to qualify for" flag; it means the usage file cannot describe this plan's load at all.

## Non-bypassable charges — per plan in the base utility file

```json
"nonbypassable_charges": {
  "ppp_per_kwh": 0.01515,
  "nd_per_kwh": 0.0,
  "ctc_per_kwh": -0.00007,
  "dwr_bc_per_kwh": 0.0,
  "wf_nbc_per_kwh": 0.00591,
  "total_per_kwh": 0.02099
}
```

Read off the **UDC Rates** table on the schedule's own sheet, which breaks the UDC Total into `Transm | Distr | PPP | ND | CTC | LGC | RS | TRAC`. PPP, ND and CTC are components *inside* UDC Total; DWR-BC and WF-NBC are added on top of it.

Only NEM 2.0 uses these. Under Schedule NEM-ST SC 1 they are billed on imports and cannot be netted away by exports, so they have to be separable from a delivery price that already contains all five.

Do not assume one schedule's figures carry to another — PPP is $0.01515 on eight of the nine residential schedules and $0.01713 on EV-TOU. The validator checks that the components sum to the total and that the total is below the plan's cheapest delivery price, since a larger total would make the netted delivery rate negative.

## Export prices — `rates/nbt-export.json`

Generated by `scripts/fetch-nbt-export.mjs`. Never hand-edited, and never hand-extended: the source is a 40 MB CSV per vintage and the point of the script is that nobody transcribes it.

```text
vintages -> "NBT26" -> "2026" -> "generation" -> "9" -> "weekday" -> [24 hourly $/kWh]
```

Hour index 0 is midnight Pacific prevailing time. Day types are `weekday` and `weekend`; holidays use the weekend row, which the generator verifies rather than assumes. The `generation` and `delivery` components are both credited — `delivery` is roughly an order of magnitude smaller and is the half a CCA customer still receives from SDG&E.

## Cities — `rates/cities.json`

```json
{
  "franchise_fee": { "base_pct": 1.1, "differentials_pct": { "San Diego": 5.78 } },
  "cities": [{ "name": "National City", "cca": "sdcp", "cca_rate_group": "2022v" }]
}
```

A city's total franchise fee is `base_pct` plus its differential, and only the City of San Diego has one. Both figures come from the Preliminary Statement, General Information H.1 — not from a bill.

`cca` and `cca_rate_group` must name a provider and rate group that exist on disk, and the city must appear in that overlay's `service_area_cities`. The validator errors if a city is filed under a rate group that another group claims, because the rate group also fixes the PCIA vintage.

Overlays therefore carry **`service_area_cities`**: a structured list whose names match `cities.json` exactly. The prose `service_area` stays for humans; matching on it is unsafe, since "San Diego" is a substring of "County of San Diego".

## Profiles — `profiles/<id>.json`

Not a rate file, but validated by the same script (`validate.mjs profiles`). A profile is a normalized *shape* plus a separate annual total.

```json
{
  "id": "solar-rooftop",
  "name": "Rooftop solar",
  "kind": "generation",
  "annual_kwh": 9300,
  "monthly_shape": [["…24 hourly values…"], "…12 months…"]
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `"load"` (default) adds consumption; `"generation"` subtracts it |
| `hourly_shape` | 24 values, applied identically to every day |
| `monthly_shape` | 12 × 24, indexed `[month-1][hour]` — needed whenever output varies by season |
| `annual_kwh` | Default total the shape is scaled to; the user overrides it |
| `specific_yield_kwh_per_kw` | Generation only. Seeds an annual total from a system size in the UI |

Exactly one shape field, and it **must normalize to 1.0** — across all 24 values, or across the whole 12 × 24 table. A shape summing to anything else silently rescales the scenario, and nothing on screen would suggest it.

Shape values are **non-negative**. Direction lives in `kind`, never in the sign of the numbers, so that a profile cannot be negated twice.

Solar needs `monthly_shape`: December output is roughly half of June's and the sun is not up at 6am in winter, so a flat daily shape puts production in hours that have none.

## Manifest — `rates/index.json`

Generated by `scripts/reindex.mjs`. Never hand-edited. Recognises four file types: `utility`, `generation`, `export_prices`, `cities`.

## Pricing models

A plan is priced one of two ways, declared by `pricing_model`. It defaults to `"tou"` when absent.

`"tou"` — priced by clock hour. `delivery` and `generation` are `season → day_type → hour blocks`, as above.

`"tiered"` — priced by cumulative consumption against the baseline allowance, with no time-of-day component. `delivery` and `generation` are `season → tiers`; there is no day_type level, because the day of week doesn't affect the bill.

```json
{
  "id": "dr",
  "name": "DR — Residential Service (tiered, non-TOU)",
  "pricing_model": "tiered",
  "delivery": {
    "summer": [
      { "up_to_pct_of_baseline": 130, "price_per_kwh": 0.22876 },
      { "up_to_pct_of_baseline": null, "price_per_kwh": 0.33539 }
    ],
    "winter": [ "…same shape…" ]
  },
  "generation": { "…same shape as delivery…" }
}
```

- Tiers are ordered by ascending threshold, and the **last tier must be `null`** (open-ended). A capped final tier leaves the heaviest usage unpriced — the tiered equivalent of an hour gap, and just as silent. The validator rejects it.
- `up_to_pct_of_baseline` is a percentage of the customer's baseline allowance accumulated across the billing period: `allowance_kwh_per_day × days_in_period × pct/100`. It is not a flat kWh number, and it depends on climate zone.
- Watch for a baseline credit that is already **folded into** the tier-1 price. SDG&E's DR works this way — its Sheet 3 UDC breakdown shows the credit inside the tier-1 rate, and it has no separate credit row. Applying `baseline.credit_per_kwh` on top would double-count it. Tiered plans should normally be absent from `baseline.credit_applies_to_plans`.
- A generation overlay for a tiered plan must also use tiers. The validator checks the overlay's shape against the utility plan's `pricing_model`.

## Hour blocks

For `pricing_model: "tou"` plans.

- `start_hour` inclusive, `end_hour` exclusive, 0–24.
- Blocks in one season × day_type array **must tile 0–24 with no gap and no overlap**. A gap silently under-bills — the validator rejects it.
- Wrapping windows (e.g. 21:00–06:00) get split into two blocks: `21→24` and `0→6`.

## Units

Tariff sheets publish prices as `$/kWh`, `¢/kWh`, or `$/MWh`. Output is always `$/kWh`.

- `¢/kWh` → divide by 100
- `$/MWh` → divide by 1000

Residential all-in retail lands roughly $0.20–$0.75/kWh; single components (delivery alone, generation alone) run lower. Validator warns outside a plausible band. **A warning means re-read the source unit, not bump the threshold.**

## Recording provenance

`source_url` and `verified_against` are required. `verified_against` must identify the document precisely enough to re-find the number: schedule name, sheet/page, revision date. "the SDG&E website" is not acceptable.
