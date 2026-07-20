/**
 * NEM 2.0 annual true-up.
 *
 * At the end of each Relevant Period — twelve billing months ending on the
 * customer's anniversary — SDG&E reconciles the account and resets it. Two
 * things happen, and they are independent of each other:
 *
 *  1. Whatever dollar credit is still banked is kept by the utility. Schedule
 *     NEM-ST SC 3(c) carries the monthly credit forward "until the end of the
 *     Relevant Period", and SC 3: "once the true-up is completed at the end of
 *     the Relevant Period, any credit for excess energy (kWh) will be retained
 *     by the Utility and the net producer will not be owed any compensation for
 *     this excess energy."
 *
 *  2. Separately, a customer whose *kWh* exported over the year exceeded the
 *     kWh imported is paid Net Surplus Compensation on the difference.
 *
 * The second test is the one people get wrong, including this calculator until
 * now. It is not a function of the dollar balance. SC 3(h) defines net surplus
 * as "all electricity generated ... measured in kilowatt-hours over a 12-month
 * period that exceeds the amount of electricity consumed", and closes the door
 * explicitly: "If a customer has not generated excess kWhs, the customer is not
 * eligible for NSC." A household can bank hundreds of dollars of credit by
 * exporting at on-peak and importing at super-off-peak, still consume more kWh
 * than it produced across the year, and be owed nothing.
 *
 * That is also why the kWh here are raw and un-TOU-weighted, sitting right
 * beside a NEM 2.0 engine that nets per TOU period per month. The two rules
 * genuinely differ: the dollar side is TOU-valued, the surplus test is not.
 *
 * Not modelled: the NSC rate. SC 3(i) sets it as net surplus kWh x a DLAP price
 * that SDG&E publishes monthly as a rolling twelve-month average of 7am-5pm
 * prices, plus a renewable adder for customers who have transferred their RECs.
 * We report the kWh and say what they would be paid on, rather than fetching a
 * rate that changes every month.
 */

import { localDateKey } from "./parse.js";

/**
 * @param {object[]} o.intervals  from parse.js
 * @param {object}   o.period     one entry from relevantPeriods()
 * @param {object[]} [o.ledger]   per-month rows from costPlan
 */
export function trueUp({ intervals, period, ledger = [] }) {
  const from = localDateKey(period.covered.from);
  const to = localDateKey(period.covered.to);

  let imported = 0;
  let exported = 0;
  for (const iv of intervals) {
    const key = localDateKey(iv.start);
    if (key < from || key > to) continue;
    imported += iv.kWh;
    exported += iv.generationKWh ?? 0;
  }

  // Positive means the year was a net consumer; negative is surplus. This is
  // the sign convention the bill prints ("current relevant period kWh Balance
  // is now -831.42 kWh"), so keeping it makes the two directly comparable.
  const netKWh = imported - exported;
  const eligibleForNSC = period.complete && netKWh < 0;

  // Ledger rows are keyed by billing month, which under a cycle anchor is named
  // for the month its read date falls in — so the window's endpoints select them
  // directly.
  const months = ledger.filter((row) => row.month >= from.slice(0, 7) && row.month <= to.slice(0, 7));

  return {
    start: period.start,
    trueUp: period.trueUp,
    // False when the file does not span the full twelve months. Every figure
    // below is still reported, but none of them is an eligibility claim.
    complete: period.complete,
    importedKWh: imported,
    exportedKWh: exported,
    netKWh,
    surplusKWh: eligibleForNSC ? -netKWh : 0,
    eligibleForNSC,
    // Dollars the utility keeps at the anniversary. Reported, never subtracted
    // from a total — it is a cost of the arrangement, not a payment.
    forfeitedCredit: months.length ? Math.max(0, -(months.at(-1).cumulativeBalance ?? 0)) : 0,
    months,
  };
}
