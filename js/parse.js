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
// Validated against a real Sempra/SDG&E export from a NEM 2.0 solar-plus-battery
// account: the parsed net for one billing period reproduced the bill's stated
// kWh to the unit, and the imported total matched the bill's Wildfire Fund base.
// The two-channel split below is the thing that has to be right — see the ESPI
// fixture in tools/test.mjs for the shape that regression-guards it.

const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

// A solar or battery account meters two channels, not one: energy delivered to
// the house (flowDirection 1) and energy the house pushes back to the grid
// (flowDirection 19). ESPI carries them as separate MeterReadings, each linked
// to a ReadingType that declares its direction and scaling. Summing both as
// consumption — which the old parser did — double-counts, and for a battery
// arbitrage account that exports hard at peak it inflates the bill several-fold
// while erasing the solar entirely. So the two channels are kept apart and
// merged by timestamp, matching the shape the CSV path already produces:
// kWh = imported, generationKWh = exported.
const FLOW_IMPORT = "1";
const FLOW_EXPORT = "19";

// href=".../ReadingType/0203" -> "0203". The id is the last path segment, so the
// same helper reads a ReadingType's own id and a MeterReading's reference to one.
const lastPathId = (href, resource) => {
  const m = new RegExp(`/${resource}/([^/"]+)`).exec(href);
  return m ? m[1] : null;
};

const entries = (xml) => xml.match(/<(?:\w+:)?entry>[\s\S]*?<\/(?:\w+:)?entry>/g) ?? [];

const selfHref = (entry, resource) => {
  const re = new RegExp(`href="([^"]*/${resource}/[^"]*)"\\s+rel="self"`);
  const m = re.exec(entry);
  return m ? m[1] : null;
};

export function parseEspiXml(text) {
  const warnings = [];

  // ReadingType id -> { flow, multiplier }. Only the direction and scaling
  // matter downstream; the rest of the ReadingType is metadata.
  const readingTypes = new Map();
  for (const e of entries(text)) {
    const href = selfHref(e, "ReadingType");
    if (!href || !/<(?:\w+:)?ReadingType>/.test(e)) continue;
    const id = lastPathId(href, "ReadingType");
    readingTypes.set(id, {
      flow: tag(e, "flowDirection"),
      multiplier: Number(tag(e, "powerOfTenMultiplier") ?? 0),
      uom: Number(tag(e, "uom") ?? 72),
      intervalLength: Number(tag(e, "intervalLength") ?? 0),
    });
  }

  // MeterReading id -> ReadingType id, taken from the MeterReading entry's
  // rel="related" link. This is the hop that tells an IntervalBlock its
  // direction, since the block itself names only its MeterReading.
  const meterToReadingType = new Map();
  for (const e of entries(text)) {
    if (!/<(?:\w+:)?MeterReading\s*\/?>/.test(e)) continue;
    const selfMr = selfHref(e, "MeterReading");
    const related = /href="([^"]*\/ReadingType\/[^"]*)"\s+rel="related"/.exec(e);
    if (selfMr && related) {
      meterToReadingType.set(lastPathId(selfMr, "MeterReading"), lastPathId(related[1], "ReadingType"));
    }
  }

  // Resolve each IntervalBlock to its channel once, cheaply, before reading any
  // values. A missing mapping is treated as import — a single-channel file with
  // no ReadingType linkage still costs correctly, as it did before.
  const readingRe = /<(?:\w+:)?IntervalReading[^>]*>([\s\S]*?)<\/(?:\w+:)?IntervalReading>/g;
  const blocks = [];
  for (const e of entries(text)) {
    if (!/<(?:\w+:)?IntervalBlock>/.test(e) || !/<(?:\w+:)?IntervalReading[^>]*>/.test(e)) continue;
    const mrId = lastPathId(selfHref(e, "MeterReading") ?? "", "MeterReading");
    const rt = readingTypes.get(meterToReadingType.get(mrId));
    blocks.push({ e, rt, flow: rt?.flow ?? FLOW_IMPORT, intervalLength: rt?.intervalLength ?? 0 });
  }
  const sawDirection = blocks.some((b) => b.rt != null);

  // A file can declare the same channel at more than one resolution — Chris's
  // ships hourly, 15-minute and daily ReadingTypes for the import side. Normally
  // only one carries data; if two ever do, summing them would silently double
  // that channel, the very failure this parser was rewritten to stop. So per
  // flow direction keep only the finest resolution present, and say so.
  const finest = new Map(); // flow -> smallest non-zero intervalLength with data
  for (const b of blocks) {
    const cur = finest.get(b.flow);
    if (b.intervalLength && (cur == null || b.intervalLength < cur)) finest.set(b.flow, b.intervalLength);
  }
  for (const [flow, len] of finest) {
    const lengths = new Set(blocks.filter((b) => b.flow === flow && b.intervalLength).map((b) => b.intervalLength));
    if (lengths.size > 1) {
      warnings.push(
        `Channel ${flow === FLOW_EXPORT ? "exported" : "imported"} is present at ${lengths.size} ` +
          `resolutions (${[...lengths].sort((a, c) => a - c).join(", ")}s); using the ${len}s readings.`,
      );
    }
  }

  // Merge the channels by start time. A key present in only one map is a real
  // reading with the other side at zero, not missing data.
  const byStart = new Map(); // epoch -> { start, durationSeconds, import, export }

  for (const { e, rt, flow, intervalLength } of blocks) {
    // Skip a coarser duplicate of a channel we also have at finer resolution.
    if (intervalLength && finest.get(flow) && intervalLength !== finest.get(flow)) continue;
    const multiplier = rt?.multiplier ?? 0;
    if (rt && rt.uom !== 72) {
      warnings.push(`ReadingType uom is ${rt.uom}, expected 72 (Wh). Values may be misscaled.`);
    }
    const toKWh = (raw) => (raw * Math.pow(10, multiplier)) / 1000;

    let m;
    while ((m = readingRe.exec(e)) !== null) {
      const block = m[1];
      const startEpoch = Number(tag(block, "start"));
      const duration = Number(tag(block, "duration"));
      const value = Number(tag(block, "value"));
      if (!Number.isFinite(startEpoch) || !Number.isFinite(value)) continue;

      let iv = byStart.get(startEpoch);
      if (!iv) {
        iv = {
          start: new Date(startEpoch * 1000),
          durationSeconds: Number.isFinite(duration) ? duration : 900,
          import: 0,
          export: 0,
        };
        byStart.set(startEpoch, iv);
      }
      if (flow === FLOW_EXPORT) iv.export += toKWh(value);
      else iv.import += toKWh(value);
    }
  }

  if (!byStart.size) {
    throw new Error("No <IntervalReading> elements found — not a Green Button ESPI export?");
  }

  const intervals = [...byStart.values()].map((iv) => ({
    start: iv.start,
    durationSeconds: iv.durationSeconds,
    kWh: iv.import,
    generationKWh: iv.export,
    netKWh: iv.import - iv.export,
  }));

  const exported = intervals.some((iv) => iv.generationKWh > 0);
  if (!sawDirection) {
    warnings.push(
      "No ReadingType flow direction found — every reading was treated as consumption. " +
        "If this account has solar or a battery, its exports are not being credited.",
    );
  }
  return finish(intervals, { format: "espi-xml", hasExport: exported }, warnings);
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
