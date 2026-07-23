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
 * Guess whether the meter data already reflects a home battery.
 *
 * This is not needed to cost the bill — the intervals are what the meter
 * recorded, battery and all, and the engine prices them as-is. It exists only to
 * stop the "add a battery" scenario from stacking a hypothetical battery on top
 * of a real one, which produces a meaningless number the same way "add solar"
 * would on a file that already has panels.
 *
 * The signal is export during the 4-8pm window. Solar cannot put a large share
 * of a year's generation there — the sun is too low by 4pm in winter and past
 * its peak in summer — so a house exporting a fifth or more of its total then is
 * discharging stored energy into the evening price peak. Measured against real
 * files: a solar-only home sits near 2%, a solar home with heavy overnight load
 * near 10%, and a grid-arbitrage battery at 35%+.
 *
 * It is a hint, not a verdict. A battery that only ever self-consumes never
 * exports at peak and will read as absent here — but such a battery also barely
 * reshapes the meter, so a hypothetical one modelled on top of it is far less
 * wrong. The cases this misses are the cases where missing it costs least.
 */
export function looksLikeBattery(intervals) {
  let total = 0;
  let evening = 0;
  for (const iv of intervals) {
    const g = iv.generationKWh ?? 0;
    if (g <= 0) continue;
    total += g;
    const h = iv.start.getHours();
    if (h >= 16 && h < 20) evening += g;
  }
  // Below a few dozen kWh of annual export the ratio is noise, not a battery.
  if (total < 50) return false;
  return evening / total > 0.2;
}

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

  // Keyed by month as well as season, because a TOU window can apply to only
  // part of a season — 10am-2pm is super-off-peak in March and April and
  // off-peak the rest of winter. A battery scheduled against the wrong one of
  // those charges at the day's most expensive hour instead of its cheapest.
  const curveFor = (season, dayType, month) => {
    const key = `${season}|${dayType}|${month}`;
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
      hourly[h] = priceAtHour(delivery, h, month) + priceAtHour(generation, h, month);
    }
    const min = Math.min(...hourly);
    const max = Math.max(...hourly);
    // A flat plan has no expensive hours to shift into. Rank everything at zero
    // so the dispatch does nothing rather than dividing by a zero spread and
    // producing arbitrage out of a rounding error.
    const spread = max - min;
    const flat = spread <= 1e-9;
    const curve = hourly.map((p) => ({
      price: p,
      rank: flat ? 0 : (p - min) / spread,
      // `rank` is a position within the day's price range, which is the wrong
      // question to ask about charging. A plan with one very expensive peak
      // stretches the range so far that a mid-priced shoulder hour still scores
      // near zero — on TOU-ELEC that puts hours 6-9, 14-15 and 21-23 under a
      // 0.25 rank threshold, so a grid battery buys at $0.3768 on a day whose
      // cheap hour is $0.3376. `cheapest` names the hours the tariff actually
      // prices lowest, independently of how far away the peak is.
      cheapest: !flat && p <= min + 1e-9,
    }));
    cache.set(key, curve);
    return curve;
  };

  return (date) => {
    const season = calendar.seasonOf(date);
    const dayType = calendar.dayTypeOf(date);
    return curveFor(season, dayType, date.getMonth() + 1)[date.getHours()];
  };
}

// Month-scoped blocks win over unscoped ones, which is how a narrow rule carves
// a window out of a broader one. Mirrors cost.js — the two must agree, or the
// battery would optimise against prices the bill never charges.
function priceAtHour(blocks, hour, month) {
  const covers = (b) => hour >= b.start_hour && hour < b.end_hour;
  const b = blocks.find((x) => x.months?.includes(month) && covers(x)) ?? blocks.find((x) => !x.months && covers(x));
  if (!b) throw new Error(`No price block covers hour ${hour} in month ${month}.`);
  return b.price_per_kwh;
}

/**
 * Run a battery over an interval series.
 *
 * `rankAt` comes from createPriceRanker and is plan-specific, so this runs once
 * per plan rather than once per series.
 *
 * Discharge into the top 40% of the day's price range. That threshold is
 * deliberately not tuned to squeeze out a better number — a tuned threshold
 * would be fitted to whichever tariff happened to be in front of it.
 *
 * Charging is not a threshold at all. It takes surplus solar whenever there is
 * any, and otherwise only the hours the tariff prices lowest. See `cheapest` in
 * createPriceRanker for why a rank threshold was the wrong instrument.
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

  let soc = floor;
  let chargedKWh = 0;
  let dischargedKWh = 0;
  let chargedFromGridKWh = 0;

  const out = intervals.map((iv) => {
    const hours = iv.durationSeconds / 3600;
    const limit = powerKW * hours;
    const { rank, cheapest } = rankAt(iv.start);

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
      } else if (strategy === "grid" && cheapest) {
        // Buy cheap now to avoid buying expensive later. This is the only path
        // that adds import, and it is what makes a battery worth anything to a
        // household with no panels.
        //
        // Reached only when there is no surplus solar this interval — solar the
        // house already generated is cheaper than any hour the tariff sells, so
        // it takes the branch above. Absent that, "cheap" means the tariff's own
        // lowest-priced hours and nothing looser: charging at a merely
        // below-average hour spends a round trip's efficiency loss to move
        // energy from one mid-priced hour to another.
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
