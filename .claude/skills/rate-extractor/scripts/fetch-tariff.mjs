#!/usr/bin/env node
// Fetch SDG&E tariff schedules straight from the tariff viewer's backing API.
//
//   node fetch-tariff.mjs list [rateGroup]     list schedules and their tarfKey
//   node fetch-tariff.mjs get <tarfKey> <out>  download one schedule as PDF
//
// The tariff viewer (tariffsprd.sdge.com) is a static Next.js export that fetches
// everything client-side, so the page HTML contains no rate data. It calls a shared
// Sempra backend, which is what this script talks to directly.
//
// The X-Azure-FDID header is required — Azure Front Door rejects requests without it.
// Both values are lifted from the viewer's own JS bundle; if this script starts
// returning 404s, re-read them from /_next/static/chunks/ on the viewer.

const BASE = "https://scg-uofa-api-prd-hzczb4hja0g6dcfv.a03.azurefd.net/scg-uofa-wpubtm-prd";
const HEADERS = { "X-Azure-FDID": "bd4def74-b0e9-45ec-aa3e-5dac6c8aa90e" };

const UTIL = "SDGE";

// Sections of the tariff book. Rate schedules live in ELEC-SCHEDS, but rules,
// the preliminary statement and the territory maps are separate sections and
// carry material the schedules only cross-reference.
const SECTIONS = {
  scheds: { book: "ELEC", sect: "ELEC-SCHEDS" },
  rules: { book: "ELEC", sect: "ELEC-RULES" },
  prelim: { book: "ELEC", sect: "ELEC-PRELIM" },
  toc: { book: "ELEC", sect: "ELEC-TOC" },
  forms: { book: "ELEC", sect: "ELEC-SF" },
  cd: { book: "ELEC", sect: "ELEC-CD" },
  gas: { book: "GAS", sect: "GAS-SCHEDS" },
};

const [cmd, ...rest] = process.argv.slice(2);

// Rate groups only apply to schedule sections; other sections list everything.
async function list(rateGroup = "Residential Rates", sectionKey = "scheds") {
  const s = SECTIONS[sectionKey];
  if (!s) throw new Error(`unknown section "${sectionKey}" — one of: ${Object.keys(SECTIONS).join(", ")}`);

  let url = `${BASE}/tariffs?utilId=${UTIL}&bookId=${s.book}&sectId=${s.sect}`;
  if (rateGroup && rateGroup !== "-") url += `&tarfRateGroup=${encodeURIComponent(rateGroup)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);

  const rows = await res.json();
  if (!rows.length) {
    console.error(`Nothing found in section "${sectionKey}" for rate group "${rateGroup}".`);
    process.exit(1);
  }
  console.log(`${rows.length} entr(ies) in ${sectionKey}${rateGroup && rateGroup !== "-" ? ` / "${rateGroup}"` : ""}:\n`);
  for (const r of rows) {
    const key = String(r.TARF_KEY).padEnd(6);
    const id = (r.TARF_ID ?? "").padEnd(16);
    console.log(`  ${key} ${id} ${r.TARF_NAME ?? ""}`);
  }
  console.log(`\nDownload one with:  node fetch-tariff.mjs get <tarfKey> <out.pdf>`);
}

async function get(tarfKey, out, book = "ELEC") {
  if (!tarfKey || !out) {
    console.error("Usage: fetch-tariff.mjs get <tarfKey> <out.pdf> [ELEC|GAS]");
    process.exit(2);
  }
  const url = `${BASE}/tariff/?utilId=${UTIL}&bookId=${book}&tarfKey=${tarfKey}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("pdf")) {
    throw new Error(`expected a PDF, got ${type} — check the tarfKey`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, buf);
  console.log(`Wrote ${out} (${buf.length} bytes).`);
  console.log(`Extract text with:  pdftotext -layout ${out} -`);
}

try {
  if (cmd === "list") await list(rest[0], rest[1]);
  else if (cmd === "get") await get(rest[0], rest[1], rest[2]);
  else {
    console.error(
      "Usage:\n" +
      "  fetch-tariff.mjs list [rateGroup] [section]   section: " + Object.keys(SECTIONS).join(", ") + "\n" +
      "  fetch-tariff.mjs get <tarfKey> <out.pdf> [ELEC|GAS]\n\n" +
      "Examples:\n" +
      '  fetch-tariff.mjs list "Residential Rates"\n' +
      '  fetch-tariff.mjs list - rules          # Rule 1, Rule 27, etc.\n' +
      "  fetch-tariff.mjs get 187 /tmp/map.pdf  # Territory Served map",
    );
    process.exit(2);
  }
} catch (e) {
  console.error(`ERROR ${e.message}`);
  process.exit(1);
}
