#!/usr/bin/env node
// Build the normalized rooftop-solar shape used by the "what if I added solar"
// scenario.
//
// WHAT THIS IS: a clear-sky geometric model. Sun position is astronomy and is
// exact; atmospheric attenuation uses a standard clear-day approximation. There
// is no weather in it at all.
//
// WHY THAT IS ACCEPTABLE HERE, AND ONLY HERE: the calculator never uses the
// magnitude of this curve. The user supplies their system's annual kWh, so the
// table is normalized to 1.0 and only its *distribution* across months and hours
// is load-bearing. Clouds mostly scale a day up or down rather than reshaping
// it, so a normalized clear-sky curve is much closer to reality than an absolute
// clear-sky curve would be.
//
// WHERE IT IS KNOWN WRONG: San Diego's May/June marine layer is a morning
// effect that burns off by midday, so real output in those two months is more
// afternoon-weighted than this symmetric curve. It also cannot know about a
// specific roof's shading or orientation.
//
// The honest fix is a PVWatts TMY pull, which replaces this file wholesale
// without any code change. This exists so the feature does not depend on a
// network round trip, not because it is better.
//
//   node .claude/skills/rate-extractor/scripts/build-solar-shape.mjs \
//     --lat 32.75 --lon -117.15 --tilt 20 --out profiles/solar-rooftop.json

import { writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const LAT = Number(arg("lat", 32.75));
const LON = Number(arg("lon", -117.15));
const TILT = Number(arg("tilt", 20));
const AZIMUTH = Number(arg("azimuth", 180)); // 180 = due south
const STANDARD_MERIDIAN = -120; // Pacific
const OUT = arg("out", "profiles/solar-rooftop.json");

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Solar declination for day-of-year n (Cooper). */
const declination = (n) => 23.45 * Math.sin(rad((360 * (284 + n)) / 365));

/** Equation of time in minutes (Spencer, abbreviated). */
function equationOfTime(n) {
  const b = rad((360 * (n - 81)) / 364);
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

/**
 * Whether Pacific prevailing time is on DST for this date. PVWatts and every
 * other production model work in local *standard* time; the meter works in
 * prevailing time. Ignoring the difference shifts the entire production curve an
 * hour late for eight months of the year, which walks output out of the on-peak
 * window and quietly changes the answer.
 */
function isDST(year, month, day) {
  // Second Sunday in March to first Sunday in November.
  const start = nthSunday(year, 2, 2);
  const end = nthSunday(year, 10, 1);
  const t = Date.UTC(year, month, day);
  return t >= Date.UTC(year, 2, start) && t < Date.UTC(year, 10, end);
}

function nthSunday(year, month, nth) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + (nth - 1) * 7;
}

/**
 * Plane-of-array irradiance for one instant, in arbitrary units.
 *
 * Direct beam uses the Meinel clear-sky attenuation with a Kasten-Young air
 * mass, projected onto the tilted plane. A flat 10% of the horizontal beam is
 * added as diffuse, which is what keeps the shoulders of the day from collapsing
 * to zero the way a beam-only model would.
 */
function irradiance(dayOfYear, solarHour) {
  const d = rad(declination(dayOfYear));
  const omega = rad(15 * (solarHour - 12));
  const phi = rad(LAT);

  const cosZenith = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(omega);
  if (cosZenith <= 0) return 0; // sun below horizon

  const zenith = Math.acos(cosZenith);
  // Kasten-Young: plain 1/cos(z) diverges at sunrise and would invent a spike.
  const airMass = 1 / (cosZenith + 0.50572 * Math.pow(96.07995 - deg(zenith), -1.6364));
  const dni = 1353 * Math.pow(0.7, Math.pow(airMass, 0.678));

  // Angle of incidence on the tilted plane.
  const beta = rad(TILT);
  const gamma = rad(AZIMUTH - 180);
  const sinAlt = cosZenith;
  const cosAlt = Math.sin(zenith);
  const solarAz = Math.atan2(
    Math.sin(omega),
    Math.cos(omega) * Math.sin(phi) - Math.tan(d) * Math.cos(phi),
  );
  const cosIncidence =
    sinAlt * Math.cos(beta) + cosAlt * Math.sin(beta) * Math.cos(solarAz - gamma);

  const beam = cosIncidence > 0 ? dni * cosIncidence : 0;
  const diffuse = 0.1 * dni * cosZenith;
  return beam + diffuse;
}

// --- build ------------------------------------------------------------------

const YEAR = 2026; // any non-leap year; only DST boundaries depend on it
const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SAMPLES_PER_HOUR = 12; // 5-minute integration

const table = Array.from({ length: 12 }, () => new Array(24).fill(0));

let dayOfYear = 0;
for (let month = 0; month < 12; month++) {
  for (let day = 1; day <= DAYS_IN[month]; day++) {
    dayOfYear++;
    const eot = equationOfTime(dayOfYear);
    const dst = isDST(YEAR, month, day) ? 1 : 0;

    for (let hour = 0; hour < 24; hour++) {
      let sum = 0;
      for (let s = 0; s < SAMPLES_PER_HOUR; s++) {
        const clock = hour + (s + 0.5) / SAMPLES_PER_HOUR;
        // clock (prevailing) -> standard -> solar
        const standard = clock - dst;
        const solar = standard + (4 * (LON - STANDARD_MERIDIAN) + eot) / 60;
        sum += irradiance(dayOfYear, solar);
      }
      table[month][hour] += sum / SAMPLES_PER_HOUR;
    }
  }
}

// Normalize the whole 12x24 table to 1.0. Everything above is in arbitrary
// irradiance units; only the distribution survives.
const total = table.flat().reduce((a, b) => a + b, 0);
const shape = table.map((row) => row.map((v) => Number((v / total).toFixed(8))));

const monthlyPct = shape.map((row) => row.reduce((a, b) => a + b, 0));

const doc = {
  id: "solar-rooftop",
  name: "Rooftop solar",
  kind: "generation",
  annual_kwh: 9300,
  specific_yield_kwh_per_kw: 1550,
  monthly_shape: shape,
  _generated_by: ".claude/skills/rate-extractor/scripts/build-solar-shape.mjs",
  _model: `Clear-sky geometric model. lat ${LAT}, lon ${LON}, tilt ${TILT}deg, azimuth ${AZIMUTH}deg (south), fixed roof mount.`,
  _units: "Fraction of annual production, normalized across the whole 12x24 table. Index [month-1][clock hour], Pacific prevailing time.",
  _monthly_pct: monthlyPct.map((v) => Number((v * 100).toFixed(2))),
  notes:
    "Modelled, not measured. Sun position is exact; atmosphere is a standard clear-day approximation and there is no weather in it. " +
    "Only the distribution is used — the calculator scales this by an annual kWh you supply, so a real quote overrides the magnitude entirely. " +
    "Known weakness: San Diego's May/June marine layer is a morning effect, so those two months are really more afternoon-weighted than this. " +
    "Replaceable wholesale by a PVWatts TMY pull with no code change.",
  _verify:
    "specific_yield_kwh_per_kw is a San Diego rule-of-thumb used only to seed the annual kWh field in the UI. It is not derived from the model above and should be checked against a real quote.",
};

writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");

console.log(`Wrote ${OUT}`);
console.log("Monthly share of annual production:");
const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
monthlyPct.forEach((v, i) => {
  const bar = "#".repeat(Math.round(v * 400));
  console.log(`  ${names[i]} ${(v * 100).toFixed(2)}%  ${bar}`);
});
const peak = shape.map((row) => row.indexOf(Math.max(...row)));
console.log(`Peak clock hour by month: ${peak.map((h, i) => `${names[i]}=${h}`).join(" ")}`);
