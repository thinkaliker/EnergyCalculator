// Green Button import. Two source formats, one normalized output.
//
//   parseIntervals(text) -> { intervals, meta, warnings }
//   intervals: [{ start: Date, durationSeconds: number, kWh, generationKWh, netKWh }]
//
// CSV and XML get separate parsers on purpose — they share nothing but the
// output shape, and a common abstraction would only obscure both.
//
// Deliberately does NOT retain name, address, account number, or meter number.
// The export carries all four; nothing downstream needs any of them, and not
// holding them is the cheapest way to keep them out of a bug report or a
// localStorage dump.

/** Sniff the format from content, not the file extension. */
export function detectFormat(text) {
  const head = text.slice(0, 2048).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<")) return "espi-xml";
  return "sdge-csv";
}

export function parseIntervals(text) {
  return detectFormat(text) === "espi-xml" ? parseEspiXml(text) : parseSdgeCsv(text);
}

// ---------------------------------------------------------------------------
// SDG&E CSV
// ---------------------------------------------------------------------------
//
// A preamble of key,value rows, then a header row, then data:
//
//   Meter Number,Date,Start Time,Duration,Consumption,Generation,Net
//   "1234","5/28/2026","12:00 AM","15","1.5100","0.0000","1.5100"
//
// Three quirks, each of which produced a wrong answer during development:
// every field is quote-wrapped, times are 12-hour with a meridiem, and lines
// end CRLF. Duration is in MINUTES here, seconds in the XML.

const HEADER_RE = /^"?Meter Number"?\s*,\s*"?Date"?/i;

function splitCsvLine(line) {
  // No embedded commas inside quoted fields in this export, so a plain split
  // is sufficient; strip the wrapping quotes afterwards.
  return line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

export function parseSdgeCsv(text) {
  const warnings = [];
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  if (headerIdx === -1) {
    throw new Error(
      "Not a recognized SDG&E CSV export — no 'Meter Number,Date,...' header row found.",
    );
  }

  const cols = splitCsvLine(lines[headerIdx]).map((c) => c.toLowerCase());
  const col = (name) => {
    const i = cols.indexOf(name);
    if (i === -1) throw new Error(`SDG&E CSV is missing the "${name}" column.`);
    return i;
  };
  const iDate = col("date");
  const iTime = col("start time");
  const iDur = col("duration");
  const iCons = col("consumption");
  // Solar exports only. Absent on non-solar accounts, so these stay optional.
  const iGen = cols.indexOf("generation");
  const iNet = cols.indexOf("net");

  const intervals = [];
  let skipped = 0;

  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    if (f.length <= iCons) {
      skipped++;
      continue;
    }

    const start = parseCsvDateTime(f[iDate], f[iTime]);
    const kWh = Number(f[iCons]);
    if (!start || !Number.isFinite(kWh)) {
      skipped++;
      continue;
    }

    const durMinutes = Number(f[iDur]);
    intervals.push({
      start,
      durationSeconds: Number.isFinite(durMinutes) ? durMinutes * 60 : 900,
      kWh,
      generationKWh: iGen === -1 ? 0 : Number(f[iGen]) || 0,
      netKWh: iNet === -1 ? kWh : Number(f[iNet]) || 0,
    });
  }

  if (skipped) warnings.push(`Skipped ${skipped} unparseable row(s).`);
  if (!intervals.length) throw new Error("SDG&E CSV contained no readable interval rows.");

  return finish(intervals, { format: "sdge-csv" }, warnings);
}

/**
 * "5/28/2026" + "12:00 AM" -> local Date.
 *
 * Built from local components rather than Date.parse so the result is local
 * wall-clock time. That matters: TOU windows are defined in local time, and
 * on DST days a UTC-based reading would shift usage into the wrong price band.
 */
function parseCsvDateTime(dateStr, timeStr) {
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr.trim());
  if (!dm) return null;
  const [, month, day, year] = dm.map(Number);

  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(timeStr.trim());
  if (!tm) return null;
  let hour = Number(tm[1]);
  const minute = Number(tm[2]);
  const second = Number(tm[3] ?? 0);
  const meridiem = tm[4];

  if (meridiem) {
    hour %= 12;
    if (/[Pp]/.test(meridiem[0])) hour += 12;
  }

  const d = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// ESPI / Green Button XML
// ---------------------------------------------------------------------------
//
// Scanned with regex rather than DOMParser so this module runs unchanged in
// Node and in the browser. ESPI interval blocks are flat and regular, which is
// the narrow case where that trade is reasonable — do not extend this into
// general-purpose XML handling.
//
// UNVERIFIED: written against the ESPI spec, not against a real SDG&E export.
// The unit handling in particular (uom 72 = Wh, powerOfTenMultiplier) has not
// been checked against a known answer the way the CSV path has. Treat XML
// results as provisional until one is run through tools/verify.mjs.

const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

export function parseEspiXml(text) {
  const warnings = [
    "ESPI XML parsing has not been validated against a real export — verify totals against your bill.",
  ];

  // ReadingType carries the units for every reading in the file.
  const uom = Number(tag(text, "uom") ?? 72);
  const multiplier = Number(tag(text, "powerOfTenMultiplier") ?? 0);
  if (uom !== 72) {
    warnings.push(`ReadingType uom is ${uom}, expected 72 (Wh). Values may be misscaled.`);
  }
  // Wh -> kWh, after applying the file's own power-of-ten multiplier.
  const toKWh = (raw) => (raw * Math.pow(10, multiplier)) / 1000;

  const intervals = [];
  const blockRe = /<(?:\w+:)?IntervalReading[^>]*>([\s\S]*?)<\/(?:\w+:)?IntervalReading>/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const block = m[1];
    const startEpoch = Number(tag(block, "start"));
    const duration = Number(tag(block, "duration"));
    const value = Number(tag(block, "value"));
    if (!Number.isFinite(startEpoch) || !Number.isFinite(value)) continue;

    intervals.push({
      start: new Date(startEpoch * 1000),
      durationSeconds: Number.isFinite(duration) ? duration : 900,
      kWh: toKWh(value),
      generationKWh: 0,
      netKWh: toKWh(value),
    });
  }

  if (!intervals.length) {
    throw new Error("No <IntervalReading> elements found — not a Green Button ESPI export?");
  }
  return finish(intervals, { format: "espi-xml", uom, powerOfTenMultiplier: multiplier }, warnings);
}

// ---------------------------------------------------------------------------

function finish(intervals, meta, warnings) {
  intervals.sort((a, b) => a.start - b.start);

  const totalKWh = intervals.reduce((s, i) => s + i.kWh, 0);
  const plausible = totalKWh / Math.max(1, countDays(intervals));
  if (plausible > 500) {
    warnings.push(
      `Average ${plausible.toFixed(0)} kWh/day is implausibly high — check the file's units.`,
    );
  }

  return {
    intervals,
    warnings,
    meta: {
      ...meta,
      start: intervals[0].start,
      end: new Date(
        intervals.at(-1).start.getTime() + intervals.at(-1).durationSeconds * 1000,
      ),
      intervalCount: intervals.length,
      totalKWh,
    },
  };
}

const countDays = (intervals) => new Set(intervals.map((i) => localDateKey(i.start))).size;

/** Local-time YYYY-MM-DD. Used as a day identity everywhere; never toISOString. */
export function localDateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
