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

### Structural consequence

A billing period can span a rate revision. The design's "pick the file whose `effective_date`
covers the usage period" is not sufficient — the calculator must be able to apply **two or more
revisions within one period**, splitting at the effective date. Until then, any period
containing a rate change carries a small error.

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
