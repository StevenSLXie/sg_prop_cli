#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_OUT_DIR = "docs/market-pulse-index/output";
const DEFAULT_SNAPSHOT = join(DEFAULT_OUT_DIR, "normalized-snapshot.json");
const SQM_TO_SQFT = 10.7639104167;
const WINDOW_MONTHS = 3;
const WEIGHT_LOOKBACK_MONTHS = 24;
const MIN_WEIGHT_LOOKBACK_MONTHS = 6;
const PROJECT_WEIGHT_CAP = 0.15;
const RETURN_WINSOR_LOG = 0.12;

const SIZE_SEGMENTS = [
  { key: "compact", label: "<=800 sqft", minSqft: -Infinity, maxSqft: 800 },
  { key: "family", label: ">800-1200 sqft", minSqft: 800, maxSqft: 1200 },
  { key: "large", label: ">1200 sqft", minSqft: 1200, maxSqft: Infinity }
];

const TIER_DEFS = [
  { tier: "project_size_floor", multiplier: 1, minN: 2, keyFn: (row) => row._atom_key },
  { tier: "project_size", multiplier: 0.75, minN: 3, keyFn: (row) => row._project_size_key },
  { tier: "project", multiplier: 0.5, minN: 4, keyFn: (row) => row._project_key }
];

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}
const outDir = args.out ?? DEFAULT_OUT_DIR;
const snapshotPath = args.snapshot ?? DEFAULT_SNAPSHOT;
const coreOnly = Boolean(args["core-only"]);

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  await mkdir(outDir, { recursive: true });
  const pulledAt = new Date().toISOString();
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const rows = snapshot.rows
    .filter(isTargetScope)
    .map(enrichRow)
    .sort((a, b) => a.contract_month.localeCompare(b.contract_month));
  const months = unique(rows.map((row) => row.contract_month)).sort();
  const universes = buildUniverses(rows, { coreOnly });
  const points = [];

  for (const universe of universes) {
    points.push(...computeUniversePoints(rows, months, universe, pulledAt));
  }

  const indexJson = {
    generated_at: pulledAt,
    calculation_mode: "revised_backtest",
    method_version: "market-pulse-soft-match-v0.2",
    source_snapshot: snapshotPath,
    scope: {
      type_of_sale: "resale",
      property_type: ["Condominium", "Apartment"],
      excluded: ["new_sale", "sub_sale", "Executive Condominium", "landed"]
    },
    parameters: {
      window_months: WINDOW_MONTHS,
      weight_lookback_months: WEIGHT_LOOKBACK_MONTHS,
      min_weight_lookback_months: MIN_WEIGHT_LOOKBACK_MONTHS,
      project_weight_cap: PROJECT_WEIGHT_CAP,
      return_winsor_log: RETURN_WINSOR_LOG,
      size_segments: SIZE_SEGMENTS.map(({ key, label, minSqft, maxSqft }) => ({ key, label, minSqft, maxSqft })),
      tiers: [
        { tier: "project_size_floor", weight_multiplier: 1, min_current_and_previous_rows: 2 },
        { tier: "project_size", weight_multiplier: 0.75, min_current_and_previous_rows: 3 },
        { tier: "project", weight_multiplier: 0.5, min_current_and_previous_rows: 4 },
        { tier: "fallback_cell", weight_multiplier: 0.25, min_current_and_previous_rows: 8 }
      ]
    },
    points
  };
  const audit = buildSampleAudit(rows, months, points, pulledAt);

  await writeJson(join(outDir, "soft-matched-sample-audit.json"), audit);
  await writeJson(join(outDir, "soft-matched-index-points.json"), indexJson);
  await writeFile(join(outDir, "soft-matched-index-points.csv"), toCsv(points), "utf8");

  console.log(JSON.stringify({
    ok: true,
    method_version: indexJson.method_version,
    target_row_count: rows.length,
    first_month: months[0],
    last_month: months.at(-1),
    point_count: points.length,
    output_dir: outDir,
    latest_core_points: latestByKey(points)
      .filter((point) => ["SG_CONDO_RESALE_OVERALL", "SG_CONDO_RESALE_CCR", "SG_CONDO_RESALE_RCR", "SG_CONDO_RESALE_OCR"].includes(point.index_key))
      .map((point) => ({
        index_key: point.index_key,
        period_end_month: point.period_end_month,
        price_index: point.price_index,
        confidence: point.confidence,
        matched_coverage: point.matched_coverage,
        fallback_share: point.fallback_share,
        top_project_weight: point.top_project_weight
      }))
  }, null, 2));
}

function buildUniverses(rows, options = {}) {
  const districts = unique(rows.map((row) => row.district).filter(Boolean)).sort();
  const segments = unique(rows.map((row) => row.market_segment).filter(Boolean)).sort();
  const universes = [
    {
      key: "SG_CONDO_RESALE_OVERALL",
      type: "overall",
      filter: () => true,
      fallbackCellKey: (row) => `${row.market_segment || "unknown"}|${row._size_key}`
    }
  ];

  for (const segment of segments) {
    universes.push({
      key: `SG_CONDO_RESALE_${segment}`,
      type: "market_segment",
      market_segment: segment,
      filter: (row) => row.market_segment === segment,
      fallbackCellKey: (row) => `${row.district || "unknown"}|${row._size_key}`
    });
  }

  if (options.coreOnly) return universes;

  for (const district of districts) {
    universes.push({
      key: `SG_CONDO_RESALE_D${district}`,
      type: "district",
      district,
      filter: (row) => row.district === district,
      fallbackCellKey: (row) => row._size_key
    });
  }

  for (const segment of SIZE_SEGMENTS) {
    universes.push({
      key: `SG_CONDO_RESALE_SIZE_${segment.key.toUpperCase()}`,
      type: "size_segment",
      size_segment: segment.key,
      filter: (row) => row._size_key === segment.key,
      fallbackCellKey: (row) => row.market_segment || "unknown"
    });
  }

  return universes;
}

function computeUniversePoints(allRows, months, universe, pulledAt) {
  const rows = allRows.filter(universe.filter);
  const rowsByMonth = groupRows(rows, (row) => row.contract_month);
  const points = [];
  let index = null;

  for (let i = WINDOW_MONTHS; i < months.length; i++) {
    const endMonth = months[i];
    const prevEndMonth = months[i - 1];
    const windowMonths = monthWindow(endMonth, WINDOW_MONTHS);
    const prevWindowMonths = monthWindow(prevEndMonth, WINDOW_MONTHS);
    const weightMonths = months
      .filter((month) => month < windowMonths[0])
      .slice(-WEIGHT_LOOKBACK_MONTHS);

    const currentRows = rowsForMonths(rowsByMonth, windowMonths);
    const sampleSize = currentRows.length;
    const liquidity = computeLiquidity(rowsByMonth, windowMonths, weightMonths);
    const result = weightMonths.length >= MIN_WEIGHT_LOOKBACK_MONTHS
      ? computeSoftMatchedReturn(rowsByMonth, universe, windowMonths, prevWindowMonths, weightMonths)
      : null;
    const confidence = confidenceFor(sampleSize, result);
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
      method_version: "market-pulse-soft-match-v0.2",
      sample_size: sampleSize,
      confidence,
      price_return_log: nullableRound(priceReturn, 6),
      rolling_momentum_pct: nullableRound(priceReturn === null ? null : Math.expm1(priceReturn) * 100, 3),
      price_index: nullableRound(priceIndex, 3),
      liquidity_index: nullableRound(liquidity.index, 3),
      transaction_count: liquidity.currentCount,
      baseline_transaction_count: nullableRound(liquidity.baselineCount, 3),
      active_atom_count: result?.active_atom_count ?? 0,
      total_atom_count: result?.total_atom_count ?? 0,
      coverage: nullableRound(result?.coverage ?? 0, 4),
      matched_coverage: nullableRound(result?.matched_coverage ?? 0, 4),
      fallback_share: nullableRound(result?.fallback_share ?? 0, 4),
      top_project_weight: nullableRound(result?.top_project_weight ?? 0, 4),
      project_count: result?.project_count ?? 0,
      dispersion: nullableRound(result?.dispersion ?? null, 6),
      tier_atom_counts: result ? JSON.stringify(result.tier_atom_counts) : ""
    });
  }

  return points;
}

function computeSoftMatchedReturn(rowsByMonth, universe, windowMonths, prevWindowMonths, weightMonths) {
  const currentRows = rowsForMonths(rowsByMonth, windowMonths);
  const prevRows = rowsForMonths(rowsByMonth, prevWindowMonths);
  const weightRows = rowsForMonths(rowsByMonth, weightMonths);
  if (!currentRows.length || !prevRows.length || !weightRows.length) return null;

  const tierReturns = new Map();
  for (const tier of TIER_DEFS) {
    tierReturns.set(tier.tier, buildReturnMap(currentRows, prevRows, tier.keyFn, tier.minN));
  }
  const fallbackReturns = buildReturnMap(currentRows, prevRows, universe.fallbackCellKey, 8);
  const atoms = buildAtoms(weightRows);
  const totalAtomWeight = atoms.reduce((sum, atom) => sum + atom.weight, 0);
  if (totalAtomWeight <= 0) return null;

  const entries = [];
  for (const atom of atoms) {
    const decision = chooseReturn(atom.rep, tierReturns, fallbackReturns, universe.fallbackCellKey);
    if (!decision) continue;
    entries.push({
      atom,
      tier: decision.tier,
      raw_return: decision.return,
      return: clamp(decision.return, -RETURN_WINSOR_LOG, RETURN_WINSOR_LOG),
      base_weight: atom.weight,
      effective_weight: atom.weight * decision.multiplier,
      project: atom.rep._project_key
    });
  }
  if (!entries.length) return null;

  const cappedEntries = capProjectWeights(entries);
  const totalEffectiveWeight = cappedEntries.reduce((sum, entry) => sum + entry.capped_weight, 0);
  if (totalEffectiveWeight <= 0) return null;

  const weightedReturn = cappedEntries.reduce((sum, entry) => sum + entry.capped_weight * entry.return, 0) / totalEffectiveWeight;
  const activeAtomWeight = entries.reduce((sum, entry) => sum + entry.base_weight, 0);
  const matchedAtomWeight = entries
    .filter((entry) => entry.tier !== "fallback_cell")
    .reduce((sum, entry) => sum + entry.base_weight, 0);
  const fallbackEffectiveWeight = cappedEntries
    .filter((entry) => entry.tier === "fallback_cell")
    .reduce((sum, entry) => sum + entry.capped_weight, 0);
  const projectWeights = groupSum(cappedEntries, (entry) => entry.project, (entry) => entry.capped_weight);
  const topProjectWeight = Math.max(0, ...projectWeights.values()) / totalEffectiveWeight;
  const tierAtomCounts = groupCounts(entries, (entry) => entry.tier);
  const returns = cappedEntries.map((entry) => entry.return);
  const medianReturn = median(returns);

  return {
    return: weightedReturn,
    coverage: activeAtomWeight / totalAtomWeight,
    matched_coverage: matchedAtomWeight / totalAtomWeight,
    fallback_share: fallbackEffectiveWeight / totalEffectiveWeight,
    top_project_weight: topProjectWeight,
    active_atom_count: entries.length,
    total_atom_count: atoms.length,
    project_count: projectWeights.size,
    dispersion: median(returns.map((value) => Math.abs(value - medianReturn))),
    tier_atom_counts: objectFromMap(tierAtomCounts)
  };
}

function chooseReturn(row, tierReturns, fallbackReturns, fallbackCellKeyFn) {
  for (const tier of TIER_DEFS) {
    const value = tierReturns.get(tier.tier).get(tier.keyFn(row));
    if (Number.isFinite(value)) return { tier: tier.tier, return: value, multiplier: tier.multiplier };
  }
  const fallback = fallbackReturns.get(fallbackCellKeyFn(row));
  if (Number.isFinite(fallback)) return { tier: "fallback_cell", return: fallback, multiplier: 0.25 };
  return null;
}

function buildReturnMap(currentRows, prevRows, keyFn, minN) {
  const current = groupRows(currentRows, keyFn);
  const previous = groupRows(prevRows, keyFn);
  const returns = new Map();
  for (const [key, currentGroup] of current.entries()) {
    const prevGroup = previous.get(key);
    if (!prevGroup || currentGroup.length < minN || prevGroup.length < minN) continue;
    const currentMedian = median(currentGroup.map((row) => row.price_psf));
    const prevMedian = median(prevGroup.map((row) => row.price_psf));
    if (currentMedian && prevMedian) returns.set(key, Math.log(currentMedian / prevMedian));
  }
  return returns;
}

function buildAtoms(weightRows) {
  const atoms = new Map();
  for (const row of weightRows) {
    const key = atomKey(row);
    const existing = atoms.get(key);
    if (existing) {
      existing.weight += row.price || 0;
    } else {
      atoms.set(key, { key, rep: row, weight: row.price || 0 });
    }
  }
  return [...atoms.values()].filter((atom) => atom.weight > 0);
}

function capProjectWeights(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.effective_weight, 0);
  const maxProjectWeight = total * PROJECT_WEIGHT_CAP;
  const byProject = groupSum(entries, (entry) => entry.project, (entry) => entry.effective_weight);
  return entries.map((entry) => {
    const projectWeight = byProject.get(entry.project) ?? 0;
    const scale = projectWeight > maxProjectWeight ? maxProjectWeight / projectWeight : 1;
    return { ...entry, capped_weight: entry.effective_weight * scale };
  });
}

function confidenceFor(sampleSize, result) {
  if (!result || sampleSize < 25 || result.coverage < 0.25) return "None";
  if (sampleSize < 50 || result.coverage < 0.4 || result.matched_coverage < 0.25 || result.top_project_weight > 0.35) return "Low";
  if (sampleSize < 100 || result.coverage < 0.55 || result.matched_coverage < 0.45 || result.top_project_weight > 0.25) return "Medium";
  return "High";
}

function computeLiquidity(rowsByMonth, windowMonths, weightMonths) {
  const currentCount = rowsForMonths(rowsByMonth, windowMonths).length;
  const rollingCounts = [];
  for (const month of weightMonths) {
    rollingCounts.push(rowsForMonths(rowsByMonth, monthWindow(month, WINDOW_MONTHS)).length);
  }
  const baselineCount = median(rollingCounts);
  return {
    currentCount,
    baselineCount,
    index: baselineCount ? (100 * currentCount) / baselineCount : null
  };
}

function buildSampleAudit(rows, months, points, pulledAt) {
  return {
    generated_at: pulledAt,
    calculation_mode: "revised_backtest",
    method_version: "market-pulse-soft-match-v0.2",
    target_row_count: rows.length,
    first_month: months[0] ?? null,
    last_month: months.at(-1) ?? null,
    month_count: months.length,
    latest_points: latestByKey(points)
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

function enrichRow(row) {
  const sizeKey = sizeSegment(row).key;
  const project = projectKey(row);
  const floor = floorBand(row);
  return {
    ...row,
    _size_key: sizeKey,
    _project_key: project,
    _project_size_key: `${project}|${sizeKey}`,
    _floor_key: floor,
    _atom_key: `${project}|${sizeKey}|${floor}`
  };
}

function atomKey(row) {
  return row._atom_key ?? `${projectKey(row)}|${sizeSegment(row).key}|${floorBand(row)}`;
}

function projectKey(row) {
  return `${row.district || "unknown"}|${String(row.project || "").trim().toUpperCase() || "unknown"}`;
}

function floorBand(row) {
  return String(row.floor_range || "unknown").trim().toUpperCase() || "unknown";
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
  for (let offset = count - 1; offset >= 0; offset--) months.push(addMonths(endMonth, -offset));
  return months;
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function rowsForMonths(rowsByMonth, months) {
  return months.flatMap((month) => rowsByMonth.get(month) ?? []);
}

function groupRows(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = map.get(key);
    if (group) group.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function groupCounts(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return new Map([...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function groupSum(rows, keyFn, valueFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + (valueFn(row) || 0));
  }
  return map;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isValidMonth(month) {
  return /^\d{4}-\d{2}$/.test(month);
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
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  return `${[columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`;
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
  console.log(`Singapore Condo Market Pulse soft matched-basket prototype

Usage:
  node docs/market-pulse-index/build-market-pulse.mjs --save-snapshot
  node docs/market-pulse-index/build-soft-matched-pulse.mjs [options]

Options:
  --snapshot <path>  Normalized transaction snapshot. Defaults to ${DEFAULT_SNAPSHOT}
  --out <dir>        Output directory. Defaults to ${DEFAULT_OUT_DIR}
  --core-only        Only compute Overall/CCR/RCR/OCR series
  -h, --help         Show this help
`);
}
