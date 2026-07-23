// SDG&E bill PDF import. Pulls the handful of "your situation" facts a Green
// Button usage file cannot carry — climate zone, NEM version, true-up date, and
// which CCA the account buys generation from — so Step 2 can be pre-filled.
//
//   parseBill(arrayBuffer) -> { fields, warnings }        (async, uses pdf.js)
//   extractBillFields(text) -> { fields, warnings }       (pure, testable)
//   fields: { climateZone, nemMode, trueUpDate, ccaProvider, ccaProduct,
//             pciaVintage, city }
//
// Split in two on purpose: pdf.js turns the PDF into text, and everything after
// that is plain string work that can be tested without a PDF at all.
//
// PRIVACY. A bill names the customer, their service address, their account
// number and their meter number, and all of those parse cleanly. This module
// returns ONLY the seven mapped fields above and nothing else. The extracted text
// is a local variable, never stored on app state and never logged — the same
// discipline parse.js keeps for the Green Button PII, for the same reason: what
// is never held cannot leak into a bug report or a localStorage dump.
//
// Reading the city means looking at the address lines, which is where the name,
// street and account also sit. We take ONLY the city — validated against the
// known-city list below — and discard the rest of the line; the street, ZIP and
// name are matched over but never captured into a field. City is as coarse as
// the climate zone we already surface, and, like it, the user sees and can edit
// what we set.
//
// Everything here is written against real SDG&E/SDCP/CEA bills EXCEPT the NEM 3.0
// branch — no Solar Billing Plan bill was available to pattern against, so that
// path is written from the spec and flagged unverified, exactly as the ESPI XML
// parser was until a real export validated it.

// Stable tariff constants — the four SDG&E climatic zones. Safe to hardcode:
// they are not going to change, and validating here lets a garbled read fall to
// null rather than setting a zone the rate files don't have.
const ZONES = ["coastal", "inland", "mountain", "desert"];

// The incorporated cities in SDG&E territory, mirroring rates/cities.json. Kept
// here — like ZONES — so the pure text pass can validate a city without loading
// the rate data. The two catch-all rows in cities.json ("Unincorporated …",
// "Somewhere else …") are omitted: they are not names that appear in a postal
// address. The runtime re-checks fields.city against cities.json before setting
// the control, so if this list ever drifts from that file the worst case is a
// city we fail to auto-fill, never one we fill wrong.
const CITIES = [
  "Carlsbad", "Chula Vista", "Coronado", "Del Mar", "El Cajon", "Encinitas",
  "Escondido", "Imperial Beach", "La Mesa", "Lemon Grove", "National City",
  "Oceanside", "Poway", "San Diego", "San Marcos", "Santee", "Solana Beach",
  "Vista",
];
// Longest first so a two-word city ("San Marcos") wins over a shorter name that
// happens to be its tail.
const CITIES_BY_LEN = [...CITIES].sort((a, b) => b.length - a.length);

// CCA generation products, by provider, longest name first so a product that is
// a prefix of another ("Clean Impact" vs "Clean Impact Plus") never masks it.
// The tier is on the bill more often than not: a CEA bill prints it on the
// generation charge line, and a non-solar SDCP bill prints it on the "Your CCA
// rate is … - 2021 Vintage - PowerBase." line. Only a solar (NEM) SDCP bill
// omits it — its CCA-rate line ends at the vintage — so that case alone yields
// no product here and the caller assumes the standard one. Mirrors the "product"
// fields in rates/cca-*.json.
const CCA_PRODUCTS = {
  cea: ["Clean Impact Plus", "Clean Impact", "Green Impact"],
  sdcp: ["Power100", "PowerBase", "PowerOn"],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const clean = (s) => s.replace(/\s+/g, " ").trim();

// The canonical city that ends the given address fragment, or null. A suffix
// match because the text before "CA #####" is "<street> <CITY>" (or just the
// city), so only its tail names the city — and validating against the closed
// list means a street or a utility PO-box line that isn't a known city yields
// null rather than a wrong guess.
function matchKnownCity(fragment) {
  const low = clean(fragment).toLowerCase();
  return (
    CITIES_BY_LEN.find(
      (name) => low === name.toLowerCase() || low.endsWith(" " + name.toLowerCase()),
    ) ?? null
  );
}

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
    ccaProduct: null,
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

  // Generation product tier, read exactly rather than assumed when the bill
  // states it — which it does on a CEA bill ("Clean Impact Plus  0 kWh X $0.001")
  // and on a non-solar SDCP bill ("… - 2021 Vintage - PowerBase."). A solar SDCP
  // bill omits it, so it matches nothing here and ccaProduct stays null. Longest
  // name first (see CCA_PRODUCTS) so "Clean Impact Plus" is never shortened to
  // "Clean Impact".
  if (fields.ccaProvider) {
    for (const name of CCA_PRODUCTS[fields.ccaProvider] ?? []) {
      if (new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(text)) {
        fields.ccaProduct = name;
        break;
      }
    }
  }

  // PCIA vintage — "... - 2021 Vintage" on the CCA rate line. SDCP only; CEA
  // bills carry no vintage and CEA overlays have none either.
  const vintage = /(\d{4})\s+Vintage/i.exec(text);
  if (vintage) fields.pciaVintage = Number(vintage[1]);

  // City. Two independent signals, both validated against CITIES so a stray
  // token can never set a bogus city:
  //
  //   1. The address block. The mailing and service addresses both print as
  //      "<street> <CITY>, CA #####". This is the broad signal — it names any
  //      city, including the CEA territories (Escondido, Carlsbad, …) that never
  //      print a franchise-fee line. The bill also carries the utility's own
  //      remittance and PO-box addresses, which match "X, CA #####" too, but
  //      their city is not in CITIES, so validation drops them. Checked against
  //      four real bills: the only known city that survives is the customer's.
  //
  //   2. The "City of X Franchise Fee Differential" CHARGE line — present only
  //      for San Diego, but unambiguous when there, so it breaks a tie and is
  //      the fallback if the address block yields nothing. The trailing
  //      "<base> x <pct>%" is essential: the same phrase in the bill's glossary
  //      ("… charged to SDG&E by the City of San Diego …") appears on every
  //      bill, so matching the phrase alone would hand every customer "San
  //      Diego". Requiring the charge amount keeps only the real line.
  const cityHits = new Map();
  const addrRe = /([A-Za-z][A-Za-z .'-]{1,40}?)[, ]+CA\s+\d{5}(?:-\d{4})?/g;
  for (let a; (a = addrRe.exec(text)); ) {
    const city = matchKnownCity(a[1]);
    if (city) cityHits.set(city, (cityHits.get(city) ?? 0) + 1);
  }

  const franchise = /City of ([A-Za-z .'-]+?)\s+Franchise Fee Differential\s+[\d.,]+\s*x\s*[\d.]+\s*%/i.exec(text);
  const franchiseCity = franchise ? matchKnownCity(franchise[1]) : null;

  if (cityHits.size === 1) {
    fields.city = [...cityHits.keys()][0];
  } else if (cityHits.size > 1) {
    // More than one known city in an address position — rare, but decide rather
    // than skip: the franchise city if it is among them, else the most frequent.
    if (franchiseCity && cityHits.has(franchiseCity)) {
      fields.city = franchiseCity;
    } else {
      fields.city = [...cityHits.entries()].sort((x, y) => y[1] - x[1])[0][0];
      warnings.push(`Your bill listed more than one city; used "${fields.city}". Check the City field below.`);
    }
  } else if (franchiseCity) {
    fields.city = franchiseCity;
  }

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
