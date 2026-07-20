// Home battery simulation.
//
// Solar needs no module of its own — it is a generation load profile, and
// applyLoadProfile in period.js handles it. A battery is different in kind: it
// carries state from one interval to the next, so the same kWh can be moved
// between hours instead of merely added or removed.
//
// WHAT THIS IS: a greedy heuristic with no foresight. At each interval it looks
// at the price now and the charge it happens to be holding, and decides. It does
// not know that tomorrow is a peak day, that a cloud is coming, or that it would
// do better saving its charge for hour 19 than spending it at hour 16.
//
// A real installer's scheduler forecasts and beats this. That means the savings
// reported here are CONSERVATIVE — the model understates a battery rather than
// overstating it. That is the direction to be wrong in for a purchase decision,
// and it is stated in the UI rather than left for the reader to discover.
//
// WHAT IT DOES NOT MODEL: degradation over the battery's life, standby losses,
// backup reserve held for outages (beyond a fixed floor), temperature effects,
// or any demand-response program that pays for exports on command.

/**
 * Nameplate sizes, chosen to bracket the residential market rather than to name
 * a product. Round-trip efficiency of 0.90 is typical of current lithium
 * systems including inverter losses in both directions.
 */
export const BATTERY_SIZES = {
  // A plug-in portable unit rather than an installed system — the class of thing
  // sold as a power station. Its inverter, not its cells, is the binding limit:
  // 1.5 kW covers a fridge and a few outlets, so it shaves the top off an evening
  // peak rather than carrying the house through one.
  tiny: { capacityKWh: 1.6, powerKW: 1.5, label: "Very small — about 1.6 kWh" },
  small: { capacityKWh: 13.5, powerKW: 5, label: "Small — about 13.5 kWh" },
  large: { capacityKWh: 27, powerKW: 10, label: "Large — about 27 kWh" },
};

export const BATTERY_STRATEGIES = ["solar", "grid"];

const DEFAULTS = { roundTripEfficiency: 0.9, reservePct: 10 };

/**
 * Rank an hour's price against the rest of its own day type and season.
 *
 * Peak windows are NOT hardcoded to 4-9pm. EV-TOU-5's expensive hours are not
 * TOU-DR1's, and a tariff revision moves them — deriving the windows from the
 * plan's own price curve keeps that a data change, the same way calendar.js
 * keeps seasons and holidays a data change.
 *
 * Returns a function (date) -> { price, rank } where rank is 0..1, 1 being the
 * most expensive hour available on that day.
 */
export function createPriceRanker({ plan, overlay, calendar }) {
  // Reject up front rather than on first lookup. A tiered plan has no hourly
  // curve at all, so there is nothing to schedule against — failing here means
  // the caller finds out when it asks for a ranker, not deep inside a dispatch
  // loop where the error reads as a data problem.
  if ((plan.pricing_model ?? "tou") !== "tou") {
    throw new Error(
      `Plan "${plan.id}" is priced by consumption tier, not by hour, so a battery ` +
        "cannot be scheduled against it.",
    );
  }

  const cache = new Map();

  const curveFor = (season, dayType) => {
    const key = `${season}|${dayType}`;
    if (cache.has(key)) return cache.get(key);

    const delivery = plan.delivery?.[season]?.[dayType];
    const generation =
      overlay?.plans?.[plan.id]?.[season]?.[dayType] ?? plan.generation?.[season]?.[dayType];
    if (!Array.isArray(delivery) || !Array.isArray(generation)) {
      throw new Error(
        `Plan "${plan.id}" has no hourly price curve for ${season}/${dayType} — ` +
          "a battery cannot be scheduled against a tiered plan.",
      );
    }

    const hourly = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      hourly[h] = priceAtHour(delivery, h) + priceAtHour(generation, h);
    }
    const min = Math.min(...hourly);
    const max = Math.max(...hourly);
    // A flat plan has no expensive hours to shift into. Rank everything at zero
    // so the dispatch does nothing rather than dividing by a zero spread and
    // producing arbitrage out of a rounding error.
    const spread = max - min;
    const curve = hourly.map((p) => ({
      price: p,
      rank: spread > 1e-9 ? (p - min) / spread : 0,
    }));
    cache.set(key, curve);
    return curve;
  };

  return (date) => {
    const season = calendar.seasonOf(date);
    const dayType = calendar.dayTypeOf(date);
    return curveFor(season, dayType)[date.getHours()];
  };
}

function priceAtHour(blocks, hour) {
  for (const b of blocks) {
    if (hour >= b.start_hour && hour < b.end_hour) return b.price_per_kwh;
  }
  throw new Error(`No price block covers hour ${hour}.`);
}

/**
 * Run a battery over an interval series.
 *
 * `rankAt` comes from createPriceRanker and is plan-specific, so this runs once
 * per plan rather than once per series.
 *
 * Thresholds: discharge into the top 40% of the day's price range, charge from
 * the bottom 25%. They are deliberately not tuned to squeeze out a better
 * number — a tuned threshold would be fitted to whichever tariff happened to be
 * in front of it.
 */
export function applyBattery(intervals, options) {
  const {
    capacityKWh,
    powerKW,
    strategy = "solar",
    rankAt,
    roundTripEfficiency = DEFAULTS.roundTripEfficiency,
    reservePct = DEFAULTS.reservePct,
  } = options;

  if (!BATTERY_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown battery strategy "${strategy}".`);
  }
  if (!capacityKWh || capacityKWh <= 0) {
    // A no-op has to be exactly a no-op, including the object identity of the
    // intervals, so "no battery" and "zero battery" can never diverge.
    return { intervals, chargedKWh: 0, dischargedKWh: 0, chargedFromGridKWh: 0, cycles: 0 };
  }

  const floor = capacityKWh * (reservePct / 100);
  // Efficiency is charged entirely on the way in, so a kWh drawn from the
  // battery is a kWh that reached it. Splitting the loss across both directions
  // gives the same round trip and makes the intermediate numbers harder to check.
  const chargeEfficiency = roundTripEfficiency;

  const DISCHARGE_ABOVE = 0.6;
  const CHARGE_BELOW = 0.25;

  let soc = floor;
  let chargedKWh = 0;
  let dischargedKWh = 0;
  let chargedFromGridKWh = 0;

  const out = intervals.map((iv) => {
    const hours = iv.durationSeconds / 3600;
    const limit = powerKW * hours;
    const { rank } = rankAt(iv.start);

    let imported = iv.kWh;
    let exported = iv.generationKWh ?? 0;

    // --- discharge: displace imports during the day's expensive hours --------
    if (rank >= DISCHARGE_ABOVE && imported > 0 && soc > floor) {
      const out = Math.min(imported, limit, soc - floor);
      imported -= out;
      soc -= out;
      dischargedKWh += out;
    }

    // --- charge --------------------------------------------------------------
    const headroom = capacityKWh - soc;
    if (headroom > 0) {
      if (exported > 0) {
        // Surplus solar charges the battery under either strategy. Storing it
        // is worth more than exporting it: under NBT a midday export earns a
        // few cents while the evening import it later displaces costs several
        // times that.
        const taken = Math.min(exported, limit, headroom / chargeEfficiency);
        exported -= taken;
        soc += taken * chargeEfficiency;
        chargedKWh += taken;
      } else if (strategy === "grid" && rank <= CHARGE_BELOW) {
        // Buy cheap now to avoid buying expensive later. This is the only path
        // that adds import, and it is what makes a battery worth anything to a
        // household with no panels.
        const room = capacityKWh - soc;
        const taken = Math.min(limit, room / chargeEfficiency);
        imported += taken;
        soc += taken * chargeEfficiency;
        chargedKWh += taken;
        chargedFromGridKWh += taken;
      }
    }

    return { ...iv, kWh: imported, generationKWh: exported, netKWh: imported - exported };
  });

  return {
    intervals: out,
    chargedKWh,
    dischargedKWh,
    chargedFromGridKWh,
    cycles: dischargedKWh / capacityKWh,
  };
}
