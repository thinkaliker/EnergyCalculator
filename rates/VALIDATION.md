# Known-answer validation

Confirmed results from checking computed output against a real SDG&E bill. No usage data or
account details are stored here — only the derived assertions, so this file is safe to commit.

Re-run these whenever the season logic, TOU period logic, or day-type classification changes.

## 2026-07-18 — EV-TOU-5, SDCP customer, billing period 5/28/2026 – 6/25/2026

Source: one SDG&E bill (29 days, 450 kWh) plus the matching 15-minute Green Button CSV.

**Interval coverage.** 2784 intervals parsed = 29 days × 96. No gaps, no duplicates.
CSV total 450.28 kWh against 450 kWh printed on the bill.

**Bucketing.** Intervals classified by season × TOU period, compared to the kWh the bill
assigns to each bucket. Bill prints whole kWh, so sub-1.0 differences are rounding.

| bucket | computed | bill | diff |
| --- | --- | --- | --- |
| winter on-peak | 7.99 | 8 | −0.01 |
| winter off-peak | 11.49 | 11 | +0.49 |
| winter super-off-peak | 42.86 | 43 | −0.14 |
| summer on-peak | 46.42 | 46 | +0.42 |
| summer off-peak | 82.98 | 83 | −0.02 |
| summer super-off-peak | 258.53 | 259 | −0.47 |

Worst bucket error 0.49 kWh — within rounding.

### What this confirms

- **Season boundary is June 1.** The bill splits the period 4 days winter / 25 days summer,
  and the computed split matches.
- **TOU windows are right** for EV-TOU-5 and TOU-DR1 (both tariffs publish identical periods):
  on-peak 16–21 daily; weekday super-off-peak 00–06 and 10–14; weekend/holiday
  super-off-peak 00–14; everything else off-peak.
- **Weekday/weekend classification is right.**
- **Juneteenth is NOT an observed holiday** on this schedule. Adding 2026-06-19 (a Friday) as a
  holiday moves 1.35 kWh from off-peak to super-off-peak and makes the worst error 1.37 kWh —
  strictly worse than treating it as a normal weekday. The remaining holiday list is still
  unverified; this method can settle each one given a bill that spans it.

### Values confirmed exact against the bill

- PCIA 2021 vintage `0.03564`/kWh — bill: `450 kWh x $.03564 = 16.04`
- Base Services Charge `0.79343`/day — bill: `$.79343 x 29 days = 23.01`
- Wildfire Fund Charge `0.00591`/kWh — bill: `450 kWh x $.00591 = 2.66`

### Green Button CSV format notes

Both gotchas silently produce zero or wrong results rather than failing:

- Every field is quote-wrapped: `"05389044","5/28/2026","12:00 AM","15","1.5100",...`
- Times are **12-hour with a meridiem**, not 24-hour. `"12:00 AM"` is hour 0 and `"12:15 PM"`
  is hour 12 — parsing the leading number as an hour gets both wrong, and silently misfiles
  every midnight and noon interval.
- Line endings are CRLF.
- Columns: `Meter Number,Date,Start Time,Duration,Consumption,Generation,Net`. Use
  `Consumption`; `Generation` is 0 for non-solar accounts.

## Dollar reconstruction — EV-TOU-5, same bill

Computed from `rates/sdge.json` plan `ev-tou-5` plus the interval data, against the printed lines.

| line | computed | bill | diff |
| --- | --- | --- | --- |
| Base Services Charge | 23.01 | 23.01 | −0.00 |
| Electricity Delivery (UDC) | 59.61 | 59.55 | +0.06 |
| Wildfire Fund Charge | 2.66 | 2.66 | 0.00 |
| Electricity Generation | 63.67 | 63.47 | +0.20 |
| PCIA 2021 | 16.05 | 16.04 | +0.01 |
| **Total Electric Charges** | **101.32** | **101.25** | **+0.07** |

7 cents on a $101 bill (0.07%). Two known causes, both expected:

1. **kWh rounding.** The CSV totals 450.28 kWh; the bill prints 450. The extra 0.28 kWh at
   roughly $0.30/kWh accounts for most of the gap.
2. **A mid-period rate change the file cannot represent.** The bill states charges ran at
   Rate 1 for 4 days and Rate 2 for the remaining 25 — delivery of `0.32682` before Jun 1
   and `0.31711` after. `sdge.json` holds only the Jun 1 2026 revision, so the first 4 days
   are priced with the wrong (newer) rate.

### Resolved 2026-07-19 — the archive

Both revisions are now held in `rates/history/`, and this period is costed on both sides of the
change. The figures above are the pre-archive ones; with it, delivery reads `59.80` and the
total `101.51`. **The correct model fits slightly worse than the incorrect one**, which is worth
explaining rather than reverting.

The bill prints both segments, so the split is checkable directly:

| segment | days | kWh (bill) | delivery (bill) |
| --- | --- | --- | --- |
| pre-Jun 1 | 4 | 62.35 (62) | 8.13 (7.98) |
| Jun 1 on | 25 | 387.93 (388) | 51.67 (51.57) |

The day and kWh splits land exactly. What remains is the bill rounding each TOU bucket's kWh to
a whole number before pricing — six buckets, each losing a fraction. Costing the whole period at
current rates fits the *total* better only by accident: underpricing those 4 days at the cheaper
June rate happens to cancel the rounding excess. Two errors in opposite directions is not
agreement.

Note this period also spans the winter/summer boundary on the same day, so generation switches
from winter to summer rates at the same moment as the price revision.

## 2026-07-19 — a period that spans a rate change, itemised

Source: a 3/27/26–4/27/26 bill on EV-TOU-5, 32 days, 503 kWh, no solar. It spans the 4/1 change
and prints **both segments in full** — kWh per TOU period, dollars, and PCIA charged twice.

> "There was a rate change on day 6 of your Billing Period. Therefore, your charges for the
> first 5 days were at Rate 1, and the remaining 27 days were at Rate 2."

| line | archive off | archive on | bill |
| --- | --- | --- | --- |
| Electricity Delivery (UDC) | 66.08 | **67.28** | 67.42 |
| PCIA (2021) | 17.91 | **17.90** | 17.92 |

Delivery error falls from `−1.34` to `−0.14`. This bill establishes the billing rule: **split at
the effective date, bucket each segment's kWh by TOU period independently, price each at its own
revision's rates, and charge the volumetric adders per segment too.**

It also cross-validates the archive itself. Every Rate 1 figure it prints — delivery `0.32322`,
super off-peak `0.03676`, winter generation `0.20013` / `0.14354` / `0.07419`, PCIA `0.03557` —
matches the 1/1/2026 Total Rates Table exactly.

## 2026-07-19 — the midday super-off-peak window is a revision, not a season

A 2/26/26–3/26/26 bill reports something different from a rate change:

> "There was a **time of use change** on day 4 of your Billing Period. Therefore, your
> consumption for the first 3 days were aggregated on TOU 1, and the remaining 26 days were
> aggregated on TOU 2."

One set of prices for the whole period, but the hour-to-period mapping moved on **3/1/2026**.
The TOU chart printed on each bill settles what moved:

| bill | winter weekday super-off-peak |
| --- | --- |
| March (2/26–3/26) | Midnight–6am; **10am–2pm in March and April** |
| April (3/27–4/27) | Midnight–6am; 10am–2pm |
| July (5/28–6/25) | Midnight–6am; 10am–2pm |

So the "March and April" restriction was itself temporary and had gone by April. Read together
with the TOU-DR1 bill — whose March, April and May periods all reconcile with the window
present, and whose earlier periods do not — the sequence is:

- **before 2026-03-01**: winter 10am–2pm is ordinary off-peak
- **2026-03-01 on**: winter 10am–2pm is super-off-peak

That is a tariff revision, so it lives in `rates/history/sdge-2026-03-01.json` — a revision whose
*prices are identical* to the one before it and whose *windows differ*. It is why no Total Rates
Table exists for 3/1/2026: no price changed.

**Effect.** Costing Jan 5 – Feb 4 2026 on EV-TOU-5 gives delivery of `81.43` with the archive
against `72.74` without — the current tariff's window understates a January bill by **$8.69**.
This is the ~180 kWh/month misplacement recorded in README, now sourced and corrected.

The hour-block schema also grew an optional `months` field for windows that genuinely apply to
part of a season. **No shipped rate file uses it**, precisely because this case turned out not to
be one: the restriction was a revision, not a recurring rule. The support is tested against a
fixture.

## Taxes and fees — bases derived from the same bill

All three reproduce the printed figures exactly:

| fee | derivation | computed | bill |
| --- | --- | --- | --- |
| State Regulatory Fee | `450 kWh × 0.001` | 0.45 | 0.45 |
| Franchise Fee Differential base | `101.25 − 16.04 (PCIA) − 2.66 (WF-NBC)` | 82.55 | 82.55 |
| Franchise Fee Equivalent base | `63.47 (imputed EECC) + 450 × 0.00437 (CARE surcharge)` | 65.44 | 65.44 |

Sources: State Regulatory Fee is **Schedule E-PUC** ($0.001/kWh, all schedules, Advice Ltr.
4763-E eff Jan 1 2026). The Franchise Fee Equivalent Surcharge is **Schedule CCA** — per
D.97-10-087 the utility imputes its own Schedule EECC to CCA customers and charges franchise
fees on that imputed commodity amount.

**Caveat on the two bases.** Neither is stated in any tariff — both were derived by finding
combinations that reproduce the bill. They match to the cent, which is strong evidence, but
from a single bill. In particular the **6.88% rate is not published** in Schedule CCA or
CCA-CRS and appears to be city-set. A second bill from a different city would confirm or
break the franchise-fee reading.

## Not yet validated

- **CCA generation totals.** The bill's CCA section ($40.72) was not reconstructed; the SDCP
  files hold TOU-DR1 only, and this customer is on EV-TOU-5.
- **Baseline credit.** EV-TOU-5 has no baseline credit, so this bill exercises none of the
  baseline logic. TOU-DR1's `−0.10663` credit and the climate-zone allowances remain unchecked
  against any real bill.
