#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SQM_TO_SQFT = 10.7639104167;
const DEFAULT_BROKER_URL = "https://sg-housing-data-mcp-spec.vercel.app/api/ura";
const DEFAULT_OUT_DIR = "research/market-pulse-index/output";

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}
const brokerUrl = args["broker-url"] ?? DEFAULT_BROKER_URL;
const outDir = args.out ?? DEFAULT_OUT_DIR;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  const pulledAt = new Date().toISOString();
  await mkdir(outDir, { recursive: true });
  const rawRows = await fetchAllSaleRows();
  const rows = rawRows
    .map(normalizeSaleRow)
    .filter(Boolean)
    .filter(isTargetScope)
    .sort((a, b) => a.contract_month.localeCompare(b.contract_month));
  await writeJson(join(outDir, "normalized-snapshot.json"), {
    generated_at: pulledAt,
    source_service: "PMI_Resi_Transaction",
    calculation_mode: "current_snapshot",
    raw_row_count: rawRows.length,
    row_count: rows.length,
    first_month: rows[0]?.contract_month ?? null,
    last_month: rows.at(-1)?.contract_month ?? null,
    rows
  });
  console.log(JSON.stringify({
    ok: true,
    raw_row_count: rawRows.length,
    row_count: rows.length,
    first_month: rows[0]?.contract_month ?? null,
    last_month: rows.at(-1)?.contract_month ?? null,
    output: join(outDir, "normalized-snapshot.json")
  }, null, 2));
}

async function fetchAllSaleRows() {
  const rows = [];
  for (const batch of [1, 2, 3, 4]) {
    console.error(`Fetching batch ${batch}`);
    const payload = await invokeUra("PMI_Resi_Transaction", { batch });
    for (const project of arrayAt(payload, "Result")) {
      const projectRecord = objectRecord(project);
      for (const transaction of arrayAt(projectRecord, "transaction")) {
        rows.push({ project: projectRecord, transaction: objectRecord(transaction), batch });
      }
    }
  }
  return rows;
}

async function invokeUra(service, params) {
  const response = await fetch(brokerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ service, params }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`URA proxy returned HTTP ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const status = String(payload.Status ?? payload.status ?? "Success").toLowerCase();
  if (status !== "success") {
    throw new Error(`URA proxy returned unsuccessful status: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

function normalizeSaleRow(wrapper) {
  const project = wrapper.project;
  const tx = wrapper.transaction;
  const area = numberAt(tx, "area");
  const price = numberAt(tx, "price");
  const contractMonth = normalizeContractMonth(stringAt(tx, "contractDate"));
  const pricePsf = area && price ? price / (area * SQM_TO_SQFT) : null;
  if (!contractMonth) return null;
  return {
    project: stringAt(project, "project"),
    street: stringAt(project, "street"),
    market_segment: stringAt(project, "marketSegment"),
    district: normalizeDistrict(stringAt(tx, "district")),
    contract_month: contractMonth,
    contract_date_raw: stringAt(tx, "contractDate"),
    type_of_sale: saleType(stringAt(tx, "typeOfSale")),
    type_of_sale_code: stringAt(tx, "typeOfSale"),
    property_type: stringAt(tx, "propertyType"),
    tenure: stringAt(tx, "tenure"),
    floor_range: stringAt(tx, "floorRange"),
    area_sqm: area,
    area_sqft: area ? area * SQM_TO_SQFT : null,
    price,
    price_psf: pricePsf,
    no_of_units: numberAt(tx, "noOfUnits"),
    batch: wrapper.batch
  };
}

function isTargetScope(row) {
  return (
    (row.type_of_sale === "resale" || row.type_of_sale === "new_sale") &&
    (row.property_type === "Condominium" || row.property_type === "Apartment") &&
    /^\d{4}-\d{2}$/.test(row.contract_month) &&
    row.area_sqm > 0 &&
    row.price > 0 &&
    row.price_psf > 0
  );
}

function saleType(code) {
  if (code === "1") return "new_sale";
  if (code === "2") return "sub_sale";
  if (code === "3") return "resale";
  return code;
}

function normalizeContractMonth(raw) {
  const value = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  if (/^\d{4}$/.test(value)) return `20${value.slice(2, 4)}-${value.slice(0, 2)}`;
  if (/^\d{6}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}`;
  return "";
}

function normalizeDistrict(value) {
  const number = Number(String(value ?? "").trim());
  return Number.isFinite(number) && number > 0 ? String(number).padStart(2, "0") : "";
}

function numberAt(record, key) {
  const value = record[key];
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function stringAt(record, key) {
  const value = record[key];
  return value === undefined || value === null ? "" : String(value);
}

function objectRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function arrayAt(record, key) {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Pull normalized URA new sale and resale condo/apartment transaction snapshot

Usage:
  node research/market-pulse-index/pull-ura-snapshot.mjs [options]

Options:
  --broker-url <url>   URA proxy URL. Defaults to ${DEFAULT_BROKER_URL}
  --out <dir>          Output directory. Defaults to ${DEFAULT_OUT_DIR}
  -h, --help           Show this help
`);
}
