// Solar: net energy metering (NEM 2.0) and net billing (NEM 3.0).
//
// The two are not variations on a theme. They price exported energy on entirely
// different principles, and a household that looks good on one can look bad on
// the other:
//
//   NEM 2.0 (Schedule NEM-ST) — exports net against imports at the *retail*
//   price of whatever TOU period they happened in. A kWh exported at 2pm and a
//   kWh imported at 2pm cancel exactly. The customer is buying storage from the
//   grid at par.
//
//   NEM 3.0 (Schedule NBT) — imports bill at retail, exports earn a separate
//   credit from an hourly avoided-cost table. Midday exports are worth around a
//   tenth of retail; September evening exports are worth several times it. The
//   grid pays what the energy is worth to it, not what it charges for it.
//
// Which one a customer is on depends on their interconnection date, which the
// Green Button export does not carry. It has to be asked.
//
// The exception that survives both: non-bypassable charges. Under NEM 2.0 they
// are billed on imports and are not netted away, so a customer who exports as
// much as they import still owes them. Getting that wrong makes a net-zero
// solar house look free, which it is not.

export const NEM_MODES = ["none", "nem2", "nem3"];

/**
 * Which plans a customer on this NEM mode may actually take.
 *
 * This is the only eligibility rule the calculator enforces. Everywhere else,
 * every plan is priced and eligibility is left as a note — but here the tariffs
 * are narrow enough, and the consequence of ignoring them large enough, that
 * ranking an ineligible plan would just be inventing an option that isn't there.
 *
 * Returns the excluded plans with their reasons so the UI can say what it
 * dropped rather than silently showing a shorter list.
 */
export function nemEligiblePlans(mode, plans) {
  const excluded = [];
  const allowed = [];

  for (const plan of plans) {
    let reason = null;

    if (mode === "nem3" && plan.id !== "ev-tou-5") {
      // Schedule NBT, RATES: "Separately metered, residential customers …
      // taking service on the NBT tariff must take service on Schedule EV-TOU-5
      // as their OAS."
      reason = "Schedule NBT requires residential solar customers to take EV-TOU-5.";
    } else if (mode === "nem2" && (plan.pricing_model ?? "tou") !== "tou") {
      // Schedule NEM-ST: residential customer-generators take service on an
      // "applicable optional Time-of-Use rate".
      reason = "Schedule NEM-ST requires a time-of-use rate, and this plan is tiered.";
    }

    if (reason) excluded.push({ id: plan.id, name: plan.name, reason });
    else allowed.push(plan);
  }

  return { allowed, excluded };
}

/**
 * Price exported energy under NEM 3.0.
 *
 * The published table is keyed by vintage, calendar year, month, day type and
 * hour — all in Pacific prevailing time, which is what the interval Dates
 * already are. Day type comes from the rate file's own calendar, so the eight
 * Rule 1 holidays price as weekends here exactly as they do everywhere else.
 *
 * Both halves of the credit are real money. The generation half is much the
 * larger; the delivery half is the part a CCA customer still receives from
 * SDG&E. CCAs publish no curve of their own — both state they use SDG&E's
 * values — so the CCA case is this same table plus a flat per-kWh adder.
 */
export function createExportPricer({ exportTable, vintage, adderPerKWh = 0, calendar }) {
  const warnings = [];
  const byYear = exportTable?.vintages?.[vintage];
  if (!byYear) {
    const known = Object.keys(exportTable?.vintages ?? {}).join(", ") || "none";
    throw new Error(`No export prices for vintage "${vintage}" (have: ${known}).`);
  }

  const availableYears = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const yearWarned = new Set();

  /**
   * A 13-month export straddles two calendar years, and each vintage's schedule
   * starts at its own interconnection year — so the year asked for is not always
   * present. Fall back to the nearest one rather than pricing those hours at
   * zero, and say so once per year rather than once per interval.
   */
  const resolveYear = (year) => {
    if (byYear[year]) return year;
    const nearest = availableYears.reduce((best, y) =>
      Math.abs(y - year) < Math.abs(best - year) ? y : best,
    );
    if (!yearWarned.has(year)) {
      yearWarned.add(year);
      warnings.push(
        `Export prices for ${year} are not in the table for vintage ${vintage}; ` +
          `used ${nearest} instead. Export credits for that year are approximate.`,
      );
    }
    return nearest;
  };

  return {
    warnings,

    /** $/kWh credited for energy exported during the interval starting at `date`. */
    priceAt(date) {
      const year = resolveYear(date.getFullYear());
      const month = date.getMonth() + 1;
      const dayType = calendar.dayTypeOf(date);
      const hour = date.getHours();
      const at = byYear[year];

      const generation = at.generation?.[month]?.[dayType]?.[hour];
      const delivery = at.delivery?.[month]?.[dayType]?.[hour];
      if (typeof generation !== "number" || typeof delivery !== "number") {
        throw new Error(
          `Export price table has no value for ${year}-${month} ${dayType} hour ${hour} ` +
            `(vintage ${vintage}) — the table has a hole in it.`,
        );
      }
      return generation + delivery + adderPerKWh;
    },
  };
}

/**
 * Settle a period's monthly energy balances.
 *
 * Credits roll forward month to month rather than being paid out, so a spring
 * month that ends in credit offsets an August that doesn't. Summing the signed
 * balances gives the same answer as carrying them — except at the end of the
 * period, where a customer left in credit is not paid it. They receive Net
 * Surplus Compensation at a wholesale rate instead, which is DLAP-indexed for
 * SDG&E and CAISO-indexed for SDCP, varies hourly, and is not modelled.
 *
 * So: clamp the energy charge at zero and report what was left over, rather
 * than quietly booking a negative bill.
 *
 * Because credits carry with no monthly settlement, the clamped total is the
 * same whether the months are walked or the whole period is summed at once. The
 * walk is still worth doing for what it reveals — how many months ended in
 * credit is the difference between a system that covers the year and one that
 * only covers spring.
 *
 * Not modelled: the minimum bill is still applied once across the period rather
 * than in every month, so a household that nets to nothing month after month is
 * charged it once instead of twelve times. Doing that properly needs a full
 * per-month bill, not just per-month energy, and only EV-TOU carries a minimum
 * bill at all.
 */
export function settleMonthlyCredits(byMonth) {
  let balance = 0;
  let monthsInCredit = 0;

  for (const month of [...byMonth.keys()].sort()) {
    const { energy } = byMonth.get(month);
    balance += energy;
    if (energy < 0) monthsInCredit++;
  }

  return {
    energyCharges: Math.max(balance, 0),
    monthsInCredit,
    // Dollars of credit the customer ends the period holding and is not paid.
    unusedCredit: balance < 0 ? -balance : 0,
  };
}
