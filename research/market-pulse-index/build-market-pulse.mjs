#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SQM_TO_SQFT = 10.7639104167;
const DEFAULT_BROKER_URL = "https://sg-housing-data-mcp-spec.vercel.app/api/ura";
const DEFAULT_OUT_DIR = "research/market-pulse-index/output";
const CELL_MIN_N = 8;
const WEIGHT_LOOKBACK_MONTHS = 24;
const WINDOW_MONTHS = 3;

const SIZE_SEGMENTS = [
  { key: "compact", label: "<=800 sqft", minSqft: -Infinity, maxSqft: 800 },
  { key: "family", label: ">800-1200 sqft", minSqft: 800, maxSqft: 1200 },
  { key: "large", label: ">1200 sqft", minSqft: 1200, maxSqft: Infinity }
];

const CONFIDENCE_WEIGHT = {
  High: 1,
  Medium: 0.75,
  Low: 0.4,
  None: 0
};

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}
const brokerUrl = args["broker-url"] ?? DEFAULT_BROKER_URL;
const outDir = args.out ?? DEFAULT_OUT_DIR;
const saveSnapshot = Boolean(args["save-snapshot"]);

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  const pulledAt = new Date().toISOString();
  await mkdir(outDir, { recursive: true });

  console.error(`Pulling URA PMI_Resi_Transaction via ${brokerUrl}`);
  const rawRows = await fetchAllSaleRows();
  const rows = rawRows
    .map(normalizeSaleRow)
    .filter(Boolean)
    .filter(isTargetScope);

  rows.sort((a, b) => a.contract_month.localeCompare(b.contract_month));

  const months = unique(rows.map((row) => row.contract_month)).sort();
  const universes = buildUniverses(rows);
  const points = [];
  for (const universe of universes) {
    points.push(...computeUniversePoints(rows, months, universe, pulledAt));
  }

  const audit = buildSampleAudit(rows, rawRows.length, months, points, pulledAt);
  const indexJson = {
    generated_at: pulledAt,
    calculation_mode: "revised_backtest",
    method_version: "market-pulse-v0.1",
    source_service: "PMI_Resi_Transaction",
    scope: {
      type_of_sale: "resale",
      property_type: ["Condominium", "Apartment"],
      excluded: ["new_sale", "sub_sale", "Executive Condominium", "landed"]
    },
    parameters: {
      window_months: WINDOW_MONTHS,
      weight_lookback_months: WEIGHT_LOOKBACK_MONTHS,
      cell_min_n: CELL_MIN_N,
      size_segments: SIZE_SEGMENTS.map(({ key, label, minSqft, maxSqft }) => ({ key, label, minSqft, maxSqft }))
    },
    points
  };

  await writeJson(join(outDir, "sample-audit.json"), audit);
  await writeJson(join(outDir, "index-points.json"), indexJson);
  await writeFile(join(outDir, "index-points.csv"), toCsv(points), "utf8");
  if (saveSnapshot) {
    await writeJson(join(outDir, "normalized-snapshot.json"), {
      generated_at: pulledAt,
      source_service: "PMI_Resi_Transaction",
      calculation_mode: "current_snapshot",
      row_count: rows.length,
      rows
    });
  }

  printSummary(audit, points);
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
    row.type_of_sale === "resale" &&
    (row.property_type === "Condominium" || row.property_type === "Apartment") &&
    isValidMonth(row.contract_month) &&
    row.area_sqm > 0 &&
    row.price > 0 &&
    row.price_psf > 0
  );
}

function buildUniverses(rows) {
  const districts = unique(rows.map((row) => row.district).filter(Boolean)).sort();
  const segments = unique(rows.map((row) => row.market_segment).filter(Boolean)).sort();
  const universes = [
    {
      key: "SG_CONDO_RESALE_OVERALL",
      type: "overall",
      filter: () => true,
      cellKey: (row) => `${row.market_segment || "unknown"}|${sizeSegment(row).key}`,
      cellLabel: "market_segment x size_segment"
    }
  ];

  for (const segment of segments) {
    universes.push({
      key: `SG_CONDO_RESALE_${segment}`,
      type: "market_segment",
      market_segment: segment,
      filter: (row) => row.market_segment === segment,
      cellKey: (row) => `${row.district || "unknown"}|${sizeSegment(row).key}`,
      fallbackCellKey: (row) => sizeSegment(row).key,
      cellLabel: "district x size_segment"
    });
  }

  for (const district of districts) {
    universes.push({
      key: `SG_CONDO_RESALE_D${district}`,
      type: "district",
      district,
      filter: (row) => row.district === district,
      cellKey: (row) => sizeSegment(row).key,
      cellLabel: "size_segment"
    });
  }

  for (const segment of SIZE_SEGMENTS) {
    universes.push({
      key: `SG_CONDO_RESALE_SIZE_${segment.key.toUpperCase()}`,
      type: "size_segment",
      size_segment: segment.key,
      filter: (row) => sizeSegment(row).key === segment.key,
      cellKey: (row) => row.market_segment || "unknown",
      fallbackDirect: true,
      cellLabel: "market_segment"
    });
  }

  return universes;
}

function computeUniversePoints(allRows, months, universe, pulledAt) {
  const rows = allRows.filter(universe.filter);
  const points = [];
  let index = null;
  const firstT = WEIGHT_LOOKBACK_MONTHS + WINDOW_MONTHS - 1;

  for (let i = firstT; i < months.length; i++) {
    const endMonth = months[i];
    const prevEndMonth = months[i - 1];
    const windowMonths = monthWindow(endMonth, WINDOW_MONTHS);
    const prevWindowMonths = monthWindow(prevEndMonth, WINDOW_MONTHS);
    const weightMonths = months.slice(i - WINDOW_MONTHS - WEIGHT_LOOKBACK_MONTHS + 1, i - WINDOW_MONTHS + 1);

    let result = computeWindowReturn(rows, universe, windowMonths, prevWindowMonths, weightMonths, universe.cellKey);
    let cell_mode = universe.cellLabel;
    if ((!result || result.coverage < 0.5) && universe.fallbackCellKey) {
      const fallback = computeWindowReturn(rows, universe, windowMonths, prevWindowMonths, weightMonths, universe.fallbackCellKey);
      if (fallback && (!result || fallback.coverage > result.coverage)) {
        result = fallback;
        cell_mode = "fallback size_segment";
      }
    }
    if ((!result || result.coverage < 0.5) && universe.fallbackDirect) {
      const direct = computeDirectReturn(rows, windowMonths, prevWindowMonths);
      if (direct) {
        result = { ...direct, active_cell_count: 1, total_cell_count: 1, coverage: 1, dispersion: 0 };
        cell_mode = "fallback direct median";
      }
    }

    const sampleSize = countRowsInMonths(rows, windowMonths);
    const liquidity = computeLiquidity(rows, windowMonths, weightMonths);
    const confidence = confidenceFor(sampleSize, result?.coverage ?? 0);
    const priceReturn = result?.return ?? null;
    const priceIndex = priceReturn === null || confidence === "None" ? null : index === null ? 100 : index * Math.exp(priceReturn);
    if (priceIndex !== null) index = priceIndex;

    points.push({
      index_key: universe.key,
      universe_type: universe.type,
      market_segment: universe.market_segment ?? "",
      district: universe.district ?? "",
      size_segment: universe.size_segment ?? "",
      period_end_month: endMonth,
      window_start_month: windowMonths[0],
      window_end_month: windowMonths.at(-1),
      as_of_date: pulledAt,
      calculation_mode: "revised_backtest",
      provisional: false,
      method_version: "market-pulse-v0.1",
      cell_mode,
      sample_size: sampleSize,
      active_cell_count: result?.active_cell_count ?? 0,
      total_cell_count: result?.total_cell_count ?? 0,
      coverage: round(result?.coverage ?? 0, 4),
      confidence,
      price_return_log: nullableRound(priceReturn, 6),
      rolling_momentum_pct: nullableRound(priceReturn === null ? null : Math.expm1(priceReturn) * 100, 3),
      price_index: nullableRound(priceIndex, 3),
      liquidity_index: nullableRound(liquidity.index, 3),
      transaction_count: liquidity.currentCount,
      baseline_transaction_count: nullableRound(liquidity.baselineCount, 3),
      dispersion: nullableRound(result?.dispersion ?? null, 6),
      pulse_score: nullableRound(pulseScore(priceReturn, liquidity.index, result?.dispersion ?? null, confidence), 2)
    });
  }

  return points;
}

function computeWindowReturn(rows, universe, windowMonths, prevWindowMonths, weightMonths, cellKeyFn) {
  const cells = unique(rows.map(cellKeyFn)).sort();
  const weightValueByCell = sumByCell(rows, weightMonths, cellKeyFn, (row) => row.price);
  const totalWeightValue = [...weightValueByCell.values()].reduce((sum, value) => sum + value, 0);
  if (totalWeightValue <= 0) return null;

  const active = [];
  for (const cell of cells) {
    const currentRows = filterByMonths(rows, windowMonths).filter((row) => cellKeyFn(row) === cell);
    const prevRows = filterByMonths(rows, prevWindowMonths).filter((row) => cellKeyFn(row) === cell);
    if (currentRows.length < CELL_MIN_N || prevRows.length < CELL_MIN_N) continue;
    const currentMedian = median(currentRows.map((row) => row.price_psf));
    const prevMedian = median(prevRows.map((row) => row.price_psf));
    const weight = weightValueByCell.get(cell) ?? 0;
    if (!currentMedian || !prevMedian || weight <= 0) continue;
    active.push({ cell, weight, return: Math.log(currentMedian / prevMedian) });
  }
  if (active.length === 0) return null;

  const activeWeight = active.reduce((sum, item) => sum + item.weight, 0);
  const weightedReturn = active.reduce((sum, item) => sum + item.weight * item.return, 0) / activeWeight;
  const coverage = activeWeight / totalWeightValue;
  return {
    return: weightedReturn,
    coverage,
    active_cell_count: active.length,
    total_cell_count: cells.filter((cell) => (weightValueByCell.get(cell) ?? 0) > 0).length,
    dispersion: median(active.map((item) => Math.abs(item.return - median(active.map((x) => x.return)))))
  };
}

function computeDirectReturn(rows, windowMonths, prevWindowMonths) {
  const currentRows = filterByMonths(rows, windowMonths);
  const prevRows = filterByMonths(rows, prevWindowMonths);
  if (currentRows.length < CELL_MIN_N || prevRows.length < CELL_MIN_N) return null;
  const currentMedian = median(currentRows.map((row) => row.price_psf));
  const prevMedian = median(prevRows.map((row) => row.price_psf));
  if (!currentMedian || !prevMedian) return null;
  return { return: Math.log(currentMedian / prevMedian) };
}

function computeLiquidity(rows, windowMonths, weightMonths) {
  const currentCount = countRowsInMonths(rows, windowMonths);
  const rollingCounts = [];
  for (const month of weightMonths) {
    rollingCounts.push(countRowsInMonths(rows, monthWindow(month, WINDOW_MONTHS)));
  }
  const baselineCount = median(rollingCounts);
  return {
    currentCount,
    baselineCount,
    index: baselineCount ? (100 * currentCount) / baselineCount : null
  };
}

function pulseScore(priceReturn, liquidityIndex, dispersion, confidence) {
  if (priceReturn === null || liquidityIndex === null || confidence === "None") return null;
  const priceMomentumScore = clamp(priceReturn / 0.02, -1, 1);
  const liquidityScore = clamp(Math.log(liquidityIndex / 100) / Math.log(1.5), -1, 1);
  const stabilityMultiplier = clamp(1 - (dispersion ?? 0) / 0.03, 0.5, 1);
  return 100 * CONFIDENCE_WEIGHT[confidence] * stabilityMultiplier * (0.55 * priceMomentumScore + 0.3 * liquidityScore);
}

function confidenceFor(sampleSize, coverage) {
  if (sampleSize >= 80 && coverage >= 0.7) return "High";
  if (sampleSize >= 40 && coverage >= 0.5) return "Medium";
  if (sampleSize >= 25) return "Low";
  return "None";
}

function buildSampleAudit(rows, rawRowCount, months, points, pulledAt) {
  const quarters = unique(rows.map((row) => quarter(row.contract_month))).sort();
  const segmentCounts = groupCounts(rows, (row) => row.market_segment || "unknown");
  const districtCounts = groupCounts(rows, (row) => row.district || "unknown");
  const sizeCounts = groupCounts(rows, (row) => sizeSegment(row).key);
  const latestPoints = latestByKey(points);
  return {
    generated_at: pulledAt,
    calculation_mode: "revised_backtest",
    raw_row_count: rawRowCount,
    target_row_count: rows.length,
    first_month: months[0] ?? null,
    last_month: months.at(-1) ?? null,
    month_count: months.length,
    quarter_counts: quarters.map((q) => ({ quarter: q, count: rows.filter((row) => quarter(row.contract_month) === q).length })),
    market_segment_counts: objectFromMap(segmentCounts),
    district_counts: objectFromMap(districtCounts),
    size_segment_counts: objectFromMap(sizeCounts),
    latest_points: latestPoints
  };
}

function latestByKey(points) {
  const byKey = new Map();
  for (const point of points) {
    const current = byKey.get(point.index_key);
    if (!current || point.period_end_month > current.period_end_month) byKey.set(point.index_key, point);
  }
  return [...byKey.values()].sort((a, b) => a.index_key.localeCompare(b.index_key));
}

function sizeSegment(row) {
  const sqft = row.area_sqft ?? row.area_sqm * SQM_TO_SQFT;
  for (const segment of SIZE_SEGMENTS) {
    if (sqft > segment.minSqft && sqft <= segment.maxSqft) return segment;
  }
  return SIZE_SEGMENTS.at(-1);
}

function monthWindow(endMonth, count) {
  const months = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    months.push(addMonths(endMonth, -offset));
  }
  return months;
}

function filterByMonths(rows, months) {
  const set = new Set(months);
  return rows.filter((row) => set.has(row.contract_month));
}

function countRowsInMonths(rows, months) {
  const set = new Set(months);
  return rows.reduce((count, row) => count + (set.has(row.contract_month) ? 1 : 0), 0);
}

function sumByCell(rows, months, cellKeyFn, valueFn) {
  const set = new Set(months);
  const map = new Map();
  for (const row of rows) {
    if (!set.has(row.contract_month)) continue;
    const key = cellKeyFn(row);
    map.set(key, (map.get(key) ?? 0) + (valueFn(row) || 0));
  }
  return map;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function groupCounts(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return new Map([...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
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

function isValidMonth(month) {
  return /^\d{4}-\d{2}$/.test(month);
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quarter(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}Q${Math.floor((monthNumber - 1) / 3) + 1}`;
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

function unique(values) {
  return [...new Set(values)];
}

function objectFromMap(map) {
  return Object.fromEntries(map.entries());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nullableRound(value, digits) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : round(value, digits);
}

function toCsv(rows) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printSummary(audit, points) {
  const latest = audit.latest_points.filter((point) => point.confidence !== "None");
  const top = [...latest].sort((a, b) => (b.pulse_score ?? -Infinity) - (a.pulse_score ?? -Infinity)).slice(0, 8);
  console.log(JSON.stringify({
    ok: true,
    calculation_mode: "revised_backtest",
    target_row_count: audit.target_row_count,
    first_month: audit.first_month,
    last_month: audit.last_month,
    point_count: points.length,
    output_dir: outDir,
    latest_top_pulse: top.map((point) => ({
      index_key: point.index_key,
      period_end_month: point.period_end_month,
      confidence: point.confidence,
      rolling_momentum_pct: point.rolling_momentum_pct,
      liquidity_index: point.liquidity_index,
      pulse_score: point.pulse_score
    }))
  }, null, 2));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Singapore Condo Market Pulse prototype

Usage:
  node research/market-pulse-index/build-market-pulse.mjs [options]

Options:
  --broker-url <url>   URA proxy URL. Defaults to ${DEFAULT_BROKER_URL}
  --out <dir>          Output directory. Defaults to ${DEFAULT_OUT_DIR}
  --save-snapshot      Also write normalized transaction rows to normalized-snapshot.json
  -h, --help           Show this help

Outputs:
  index-points.csv
  index-points.json
  sample-audit.json

Scope:
  URA resale Condominium/Apartment only. Excludes EC, new sale, sub sale, landed.
`);
}
