// SDG&E bill PDF import. Pulls the handful of "your situation" facts a Green
// Button usage file cannot carry — climate zone, NEM version, true-up date, and
// which CCA the account buys generation from — so Step 2 can be pre-filled.
//
//   parseBill(arrayBuffer) -> { fields, warnings }        (async, uses pdf.js)
//   extractBillFields(text) -> { fields, warnings }       (pure, testable)
//   fields: { climateZone, nemMode, trueUpDate, ccaProvider, pciaVintage, city }
//
// Split in two on purpose: pdf.js turns the PDF into text, and everything after
// that is plain string work that can be tested without a PDF at all.
//
// PRIVACY. A bill names the customer, their service address, their account
// number and their meter number, and all of those parse cleanly. This module
// returns ONLY the six mapped fields above and nothing else. The extracted text
// is a local variable, never stored on app state and never logged — the same
// discipline parse.js keeps for the Green Button PII, for the same reason: what
// is never held cannot leak into a bug report or a localStorage dump.
//
// Everything here is written against real SDG&E/SDCP/CEA bills EXCEPT the NEM 3.0
// branch — no Solar Billing Plan bill was available to pattern against, so that
// path is written from the spec and flagged unverified, exactly as the ESPI XML
// parser was until a real export validated it.

// Stable tariff constants — the four SDG&E climatic zones. Safe to hardcode:
// they are not going to change, and validating here lets a garbled read fall to
// null rather than setting a zone the rate files don't have.
const ZONES = ["coastal", "inland", "mountain", "desert"];

const clean = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Map the text of a bill to Step-2 fields. Every field is independent and
 * nullable: a bill that does not state something yields null for it rather than
 * a guess, and the caller leaves that control alone.
 */
export function extractBillFields(text) {
  const warnings = [];
  const fields = {
    climateZone: null,
    nemMode: null,
    trueUpDate: null,
    ccaProvider: null,
    pciaVintage: null,
    city: null,
  };

  // Climate zone — "Rate: ... Climate Zone: Inland" on the electric rate line.
  const zone = /Climate Zone:\s*([A-Za-z]+)/i.exec(text);
  if (zone) {
    const z = zone[1].toLowerCase();
    if (ZONES.includes(z)) fields.climateZone = z;
    else warnings.push(`Climate zone "${zone[1]}" is not one of the four SDG&E zones; left unset.`);
  }

  // NEM version. A "Net Energy Metering Summary" block prints "Version: 2.0".
  // NEM 3.0 accounts are on the Solar Billing Plan / Net Billing Tariff instead.
  const version = /Version:\s*(\d\.\d)/.exec(text);
  const looksNbt = /Solar Billing Plan|Net Billing Tariff|\bNBT\b/i.test(text);
  const looksNem = /Net Energy Metering|NEM Balance|Relevant Period/i.test(text);
  if (version?.[1] === "3.0" || looksNbt) {
    fields.nemMode = "nem3";
    warnings.push(
      "Detected NEM 3.0 / Solar Billing Plan, but this reading is unverified — no such bill " +
        "was available to check the labels against. Confirm the Solar setting.",
    );
  } else if (version?.[1] === "2.0" || looksNem) {
    fields.nemMode = "nem2";
  }
  // No NEM markers at all leaves nemMode null — a non-solar bill says nothing
  // about solar, and "no solar" is already the form default.

  // True-up date — "True-Up Date: MM/DD/YYYY" in the NEM summary block, the most
  // consistent of the several places the date appears.
  const tu = /True-?Up Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
  if (tu) {
    const [, m, d, y] = tu;
    fields.trueUpDate = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // CCA provider — named in full on the bill. Drives which overlay list Step 2
  // offers; the exact product tier is not on a NEM bill, so only the provider
  // (and, below, the vintage) come from here.
  if (/SAN DIEGO COMMUNITY POWER|\bSDCP\b/i.test(text)) fields.ccaProvider = "sdcp";
  else if (/CLEAN ENERGY ALLIANCE|\bCEA\b/i.test(text)) fields.ccaProvider = "cea";

  // PCIA vintage — "... - 2021 Vintage" on the CCA rate line. SDCP only; CEA
  // bills carry no vintage and CEA overlays have none either.
  const vintage = /(\d{4})\s+Vintage/i.exec(text);
  if (vintage) fields.pciaVintage = Number(vintage[1]);

  // City — only the "City of X Franchise Fee Differential" CHARGE line names it
  // reliably (mainly San Diego). The trailing "<base> x <pct>%" is essential:
  // the same phrase appears in the bill's glossary ("... Differential - A fee
  // charged to SDG&E by the City of San Diego ...") on every bill regardless of
  // the customer's actual city, so matching the phrase alone hands an Escondido
  // customer "San Diego". Requiring the charge amount keeps only the real line.
  // Cities without a differential (CEA territories) drop the line entirely and
  // stay null — we do not infer city from the ZIP. Validated by the caller.
  const cityLine = /City of ([A-Za-z .'-]+?)\s+Franchise Fee Differential\s+[\d.,]+\s*x\s*[\d.]+\s*%/i.exec(text);
  if (cityLine) fields.city = clean(cityLine[1]);

  return { fields, warnings };
}

/**
 * Extract the bill's text with pdf.js, then map it. pdf.js is imported lazily so
 * the ~350 KB library is fetched only when a user actually drops a bill — the
 * usage-data flow and first paint never load it.
 *
 * Lines are rebuilt from positioned text items: pdf.js returns each run with its
 * transform, and a bill's labels and values share a visual row, so items are
 * grouped by y and sorted by x. A naive concatenation would interleave columns
 * and break every "Label: value" pattern above.
 */
export async function parseBill(arrayBuffer) {
  // Load pdf.js and its worker module up front. Importing the worker module on
  // the main thread registers globalThis.pdfjsWorker, which makes pdf.js run the
  // parse in-page rather than spawning a Web Worker. That is deliberate: the
  // module-Worker path proved flaky — it hangs silently on a cold start and when
  // workerSrc is an absolute URL — whereas the in-page handler is deterministic,
  // and one small bill parses in well under a second either way. The legacy
  // build is vendored (not the modern one) because only its worker code runs to
  // completion here.
  const [pdfjs] = await Promise.all([
    import("../vendor/pdf.mjs"),
    import("../vendor/pdf.worker.mjs"),
  ]);
  // Still set for the fallback path; a root-relative pathname, never a full URL.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.mjs", import.meta.url).pathname;

  // isEvalSupported:false keeps pdf.js off its optional eval path, so the page
  // stays clean under a strict Content-Security-Policy.
  const doc = await pdfjs.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += "\n" + itemsToLines(content.items);
  }
  // Release the document; nothing downstream keeps a reference to it or its text.
  await doc.destroy?.();

  return extractBillFields(text);
}

// Group pdf.js text items into visual lines. Items whose baseline y is within a
// couple of points are the same row; within a row, order by x.
function itemsToLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = Math.round(it.transform[5]);
    // Snap near-equal baselines together so sub-pixel drift does not split a row.
    const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x: it.transform[4], str: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top of page (higher y) first
    .map(([, runs]) => runs.sort((a, b) => a.x - b.x).map((r) => r.str).join(" "))
    .join("\n");
}
