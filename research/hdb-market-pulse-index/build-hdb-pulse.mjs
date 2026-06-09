#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalText,
  capWeights,
  clamp,
  addMonths,
  groupCounts,
  groupRows,
  groupSum,
  isValidMonth,
  median,
  monthWindow,
  monthsBetween,
  nullableRound,
  objectFromMap,
  parseArgs,
  percentile,
  previousCompletedMonth,
  rowsForMonths,
  toCsv,
  unique,
  weightedAverage,
  weightedMedian,
  weightedPercentile,
  writeJson
} from "../lib/market-pulse-core.mjs";

const DEFAULT_OUT_DIR = "research/hdb-market-pulse-index/output";
const DEFAULT_START_MONTH = "2022-01";
const HDB_RESALE_RESOURCE_ID = "d_8b84c4ee58e3cfc0ece0d773c8ca6abc";
const DATASTORE_SEARCH_URL = "https://data.gov.sg/api/action/datastore_search";
const WINDOW_MONTHS = 3;
const WEIGHT_LOOKBACK_MONTHS = 24;
const MIN_WEIGHT_LOOKBACK_MONTHS = 6;
const RETURN_WINSOR_LOG = 0.12;
const FLOOR_KERNEL_SCALE = 8;
const BLOCK_WEIGHT_CAP = 0.15;
const STREET_WEIGHT_CAP = 0.30;
const FLAT_TYPES = ["2 ROOM", "3 ROOM", "4 ROOM", "5 ROOM", "EXECUTIVE"];
const LEASE_BUCKETS = ["<40", "40-49", "50-59", "60-69", "70-79", "80-89", "90-99"];
const TIER_DEFS = [
  {
    tier: "same_block_street_area_lease_floor_kernel",
    multiplier: 3.0,
    minN: 2,
    keyFn: (row) => `${row._block_key}|${row._area_bucket}|${row._lease_bucket}`
  },
  {
    tier: "same_street_area_lease_floor_kernel",
    multiplier: 2.0,
    minN: 4,
    keyFn: (row) => `${row._street_key}|${row._area_bucket}|${row._lease_bucket}`
  },
  {
    tier: "same_town_flat_area_lease_floor_kernel",
    multiplier: 1.5,
    minN: 8,
    keyFn: (row) => `${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`
  }
];

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const outDir = args.out ?? DEFAULT_OUT_DIR;
const startMonth = args["start-month"] ?? DEFAULT_START_MONTH;
const endMonth = args["end-month"] ?? previousCompletedMonth();
const snapshotPath = args.snapshot ?? join(outDir, "normalized-hdb-snapshot.json");
const saveSnapshot = args["save-snapshot"] !== false;
const useExistingSnapshot = Boolean(args["use-existing-snapshot"]);
const includeTownFlat = Boolean(args["include-town-flat"]);

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  if (!isValidMonth(startMonth) || !isValidMonth(endMonth) || startMonth > endMonth) {
    throw new Error(`Invalid month range: ${startMonth} to ${endMonth}`);
  }

  await mkdir(outDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const snapshot = useExistingSnapshot ? JSON.parse(await readFile(snapshotPath, "utf8")) : await buildSnapshot(generatedAt);
  if (saveSnapshot && !useExistingSnapshot) await writeJson(snapshotPath, snapshot);
  const rows = snapshot.rows
    .filter((row) => row.month >= startMonth && row.month <= endMonth)
    .map(enrichRow)
    .filter(isIndexScope)
    .sort((a, b) => a.month.localeCompare(b.month));
  const months = unique(rows.map((row) => row.month)).sort();
  const universes = buildUniverses(rows, { includeTownFlat });
  const points = [];

  for (const universe of universes) {
    points.push(...computeUniversePoints(rows, months, universe, generatedAt));
  }

  const indexJson = {
    generated_at: generatedAt,
    calculation_mode: "revised_backtest",
    method_version: "hdb-market-pulse-soft-match-v0.2",
    source_snapshot: snapshotPath,
    source: {
      backend: "data.gov.sg",
      resource_id: HDB_RESALE_RESOURCE_ID,
      collection_id: "189"
    },
    scope: {
      transaction_type: "HDB resale",
      start_month: startMonth,
      end_month: endMonth,
      included_flat_types: FLAT_TYPES,
      excluded_flat_types: ["1 ROOM", "MULTI-GENERATION"],
      note: "Uses 2017-current HDB resale dataset; this prototype starts from 2022-01."
    },
    parameters: {
      window_months: WINDOW_MONTHS,
      public_price_index_frequency: "quarterly",
      public_price_index_return: "non-overlapping current quarter vs previous quarter",
      monthly_rolling_momentum: "overlapping 3-month window, not chained into price_index",
      weight_lookback_months: WEIGHT_LOOKBACK_MONTHS,
      min_weight_lookback_months: MIN_WEIGHT_LOOKBACK_MONTHS,
      return_winsor_log: RETURN_WINSOR_LOG,
      floor_kernel_scale: FLOOR_KERNEL_SCALE,
      block_weight_cap: BLOCK_WEIGHT_CAP,
      street_weight_cap: STREET_WEIGHT_CAP,
      main_cell: "town x flat_type",
      normalization_attributes: ["area_bucket_10sqm", "remaining_lease_10y"],
      match_tiers: TIER_DEFS.map(({ tier, multiplier, minN }) => ({ tier, weight_multiplier: multiplier, min_current_and_previous_rows: minN })),
      fallback_tiers: [
        { tier: "fallback_town_flat_area_lease", min_current_and_previous_rows: 8 },
        { tier: "fallback_town_flat_lease", min_current_and_previous_rows: 8 },
        { tier: "fallback_town_flat", min_current_and_previous_rows: 8 }
      ],
      include_town_flat_universes: includeTownFlat
    },
    points
  };
  const audit = buildAudit(rows, months, points, generatedAt);

  await writeJson(join(outDir, "hdb-index-points.json"), indexJson);
  await writeFile(join(outDir, "hdb-index-points.csv"), toCsv(points), "utf8");
  await writeJson(join(outDir, "hdb-sample-audit.json"), audit);
  await writeFile(join(outDir, "hdb-cell-audit.csv"), toCsv(buildCellAudit(rows)), "utf8");
  await writeFile(join(outDir, "hdb-flat-model-area-audit.csv"), toCsv(buildFlatModelAreaAudit(rows)), "utf8");

  console.log(JSON.stringify({
    ok: true,
    method_version: indexJson.method_version,
    row_count: rows.length,
    first_month: months[0],
    last_month: months.at(-1),
    point_count: points.length,
      output_dir: outDir,
    latest_core_points: latestPublishedByKey(points)
      .filter((point) => ["SG_HDB_RESALE_OVERALL", "SG_HDB_RESALE_3_ROOM", "SG_HDB_RESALE_4_ROOM", "SG_HDB_RESALE_5_ROOM", "SG_HDB_RESALE_EXECUTIVE"].includes(point.index_key))
      .map((point) => ({
        index_key: point.index_key,
        period_end_month: point.period_end_month,
        price_index: point.price_index,
        confidence: point.confidence,
        matched_coverage: point.matched_coverage,
        fallback_share: point.fallback_share,
        top_block_weight: point.top_block_weight,
        top_street_weight: point.top_street_weight
      }))
  }, null, 2));
}

async function buildSnapshot(generatedAt) {
  const rawRows = [];
  for (const month of monthsBetween(startMonth, endMonth)) {
    const rows = await fetchMonthRows(month);
    rawRows.push(...rows);
    console.error(`Fetched HDB ${month}: ${rows.length} rows`);
  }

  const rows = rawRows
    .map(normalizeRawRow)
    .filter(Boolean)
    .sort((a, b) => a.month.localeCompare(b.month) || a.town.localeCompare(b.town));

  return {
    generated_at: generatedAt,
    source_service: "data.gov.sg datastore_search",
    resource_id: HDB_RESALE_RESOURCE_ID,
    start_month: startMonth,
    end_month: endMonth,
    raw_row_count: rawRows.length,
    row_count: rows.length,
    rows
  };
}

async function fetchMonthRows(month) {
  const rows = [];
  const limit = 5000;
  for (let offset = 0; ; offset += limit) {
    const url = new URL(DATASTORE_SEARCH_URL);
    url.searchParams.set("resource_id", HDB_RESALE_RESOURCE_ID);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("filters", JSON.stringify({ month }));
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`data.gov.sg returned HTTP ${response.status} for ${month}: ${await response.text()}`);
    const payload = await response.json();
    if (!payload.success || !payload.result) throw new Error(`data.gov.sg returned unsuccessful payload for ${month}`);
    const batch = payload.result.records ?? [];
    rows.push(...batch);
    if (batch.length < limit || rows.length >= (payload.result.total ?? 0)) break;
  }
  return rows;
}

function normalizeRawRow(row) {
  const month = String(row.month ?? "").trim();
  const area = numberAt(row, "floor_area_sqm");
  const price = numberAt(row, "resale_price");
  if (!isValidMonth(month) || !area || !price) return null;
  return {
    month,
    town: canonicalText(row.town),
    flat_type: canonicalText(row.flat_type),
    block: canonicalText(row.block),
    street_name: canonicalText(row.street_name),
    storey_range: canonicalText(row.storey_range),
    floor_area_sqm: area,
    flat_model: canonicalText(row.flat_model),
    lease_commence_date: numberAt(row, "lease_commence_date"),
    remaining_lease: String(row.remaining_lease ?? "").trim(),
    remaining_lease_months: remainingLeaseMonths(row),
    resale_price: price,
    price_psm: price / area
  };
}

function enrichRow(row) {
  const areaBucket = areaBucket10(row.floor_area_sqm);
  const leaseBucket = leaseBucket10(row.remaining_lease_months);
  const floorMid = floorMidpoint(row.storey_range);
  const floorKey = row.storey_range || "UNKNOWN";
  const flatModelGroup = flatModelGroupFor(row.flat_model);
  const townFlatKey = `${row.town}|${row.flat_type}`;
  const streetKey = `${row.town}|${row.street_name}|${row.flat_type}`;
  const blockKey = `${row.town}|${row.street_name}|${row.block}|${row.flat_type}`;
  return {
    ...row,
    _area_bucket: areaBucket,
    _lease_bucket: leaseBucket,
    _floor_key: floorKey,
    _floor_mid: floorMid,
    _floor_bucket: floorBucket(floorMid),
    _flat_model_group: flatModelGroup,
    _town_flat_key: townFlatKey,
    _street_key: streetKey,
    _block_key: blockKey,
    _atom_key: `${blockKey}|${areaBucket}|${leaseBucket}|${floorKey}`
  };
}

function isIndexScope(row) {
  return (
    FLAT_TYPES.includes(row.flat_type) &&
    row.town &&
    row.floor_area_sqm > 0 &&
    row.resale_price > 0 &&
    row.price_psm > 0 &&
    row._lease_bucket !== "unknown"
  );
}

function buildUniverses(rows, options = {}) {
  const towns = unique(rows.map((row) => row.town)).sort();
  const flatTypes = unique(rows.map((row) => row.flat_type)).filter((type) => FLAT_TYPES.includes(type)).sort(sortFlatTypes);
  const townFlatKeys = unique(rows.map((row) => row._town_flat_key)).sort();
  const universes = [
    {
      key: "SG_HDB_RESALE_OVERALL",
      type: "overall",
      filter: () => true,
      normalizedCellKey: (row) => row._town_flat_key,
      fallbackCellKeys: [
        (row) => `${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`,
        (row) => `${row._town_flat_key}|${row._lease_bucket}`,
        (row) => row._town_flat_key
      ]
    }
  ];

  for (const flatType of flatTypes) {
    universes.push({
      key: `SG_HDB_RESALE_${keyPart(flatType)}`,
      type: "flat_type",
      flat_type: flatType,
      filter: (row) => row.flat_type === flatType,
      normalizedCellKey: (row) => row._town_flat_key,
      fallbackCellKeys: [
        (row) => `${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`,
        (row) => `${row._town_flat_key}|${row._lease_bucket}`,
        (row) => row._town_flat_key
      ]
    });
  }

  for (const bucket of LEASE_BUCKETS) {
    universes.push({
      key: `SG_HDB_RESALE_LEASE_${keyPart(bucket)}`,
      type: "lease_bucket",
      lease_bucket: bucket,
      filter: (row) => row._lease_bucket === bucket,
      normalizedCellKey: (row) => `${row._town_flat_key}|${row._lease_bucket}`,
      fallbackCellKeys: [
        (row) => `${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`,
        (row) => `${row._town_flat_key}|${row._lease_bucket}`,
        (row) => row._town_flat_key
      ]
    });
  }

  for (const town of towns) {
    universes.push({
      key: `SG_HDB_RESALE_TOWN_${keyPart(town)}`,
      type: "town",
      town,
      filter: (row) => row.town === town,
      normalizedCellKey: (row) => row._town_flat_key,
      fallbackCellKeys: [
        (row) => `${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`,
        (row) => `${row._town_flat_key}|${row._lease_bucket}`,
        (row) => row._town_flat_key
      ]
    });
  }

  if (options.includeTownFlat) {
    for (const townFlatKey of townFlatKeys) {
      const [town, flatType] = townFlatKey.split("|");
      universes.push({
        key: `SG_HDB_RESALE_TOWN_FLAT_${keyPart(town)}_${keyPart(flatType)}`,
        type: "town_flat_type",
        town,
        flat_type: flatType,
        filter: (row) => row._town_flat_key === townFlatKey,
        normalizedCellKey: (row) => row._town_flat_key,
        fallbackCellKeys: [
          (row) => `${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`,
          (row) => `${row._town_flat_key}|${row._lease_bucket}`,
          (row) => row._town_flat_key
        ]
      });
    }
  }

  return universes;
}

function computeUniversePoints(allRows, months, universe, generatedAt) {
  const rows = allRows.filter(universe.filter);
  const rowsByMonth = groupRows(rows, (row) => row.month);
  const points = [];
  let rawIndex = null;
  let publicIndex = null;

  for (let i = WINDOW_MONTHS; i < months.length; i++) {
    const endMonth = months[i];
    const windowMonths = monthWindow(endMonth, WINDOW_MONTHS);
    const rollingPrevWindowMonths = monthWindow(addMonths(endMonth, -1), WINDOW_MONTHS);
    const publicPrevWindowMonths = monthWindow(addMonths(endMonth, -WINDOW_MONTHS), WINDOW_MONTHS);
    const weightMonths = months.filter((month) => month < windowMonths[0]).slice(-WEIGHT_LOOKBACK_MONTHS);
    const currentRows = rowsForMonths(rowsByMonth, windowMonths);
    const sampleSize = currentRows.length;
    const liquidity = computeLiquidity(rowsByMonth, windowMonths, weightMonths);
    const rollingResult = weightMonths.length >= MIN_WEIGHT_LOOKBACK_MONTHS
      ? computeSoftMatchedReturn(rowsByMonth, universe, windowMonths, rollingPrevWindowMonths, weightMonths)
      : null;
    const isQuarterEnd = isQuarterEndMonth(endMonth);
    const result = isQuarterEnd && weightMonths.length >= MIN_WEIGHT_LOOKBACK_MONTHS
      ? computeSoftMatchedReturn(rowsByMonth, universe, windowMonths, publicPrevWindowMonths, weightMonths)
      : null;
    const diagnosticResult = result ?? rollingResult;
    const confidence = confidenceFor(sampleSize, diagnosticResult);
    const publicConfidence = confidenceFor(sampleSize, result);
    const priceReturn = result?.return ?? null;
    const rollingReturn = rollingResult?.return ?? null;
    const nextRawIndex = priceReturn === null ? null : rawIndex === null ? 100 : rawIndex * Math.exp(priceReturn);
    if (nextRawIndex !== null) rawIndex = nextRawIndex;

    let priceIndex = null;
    let publishedReturn = null;
    if (priceReturn !== null && publicConfidence !== "None") {
      priceIndex = publicIndex === null ? 100 : publicIndex * Math.exp(priceReturn);
      publishedReturn = priceReturn;
      publicIndex = priceIndex;
    }

    points.push({
      index_key: universe.key,
      universe_type: universe.type,
      town: universe.town ?? "",
      flat_type: universe.flat_type ?? "",
      lease_bucket: universe.lease_bucket ?? "",
      period_end_month: endMonth,
      window_start_month: windowMonths[0],
      window_end_month: windowMonths.at(-1),
      as_of_date: generatedAt,
      calculation_mode: "revised_backtest",
      provisional: false,
      method_version: "hdb-market-pulse-soft-match-v0.2",
      index_frequency: isQuarterEnd ? "quarterly" : "monthly_momentum_only",
      sample_size: sampleSize,
      confidence: isQuarterEnd ? publicConfidence : confidence,
      price_return_log: nullableRound(priceReturn, 6),
      rolling_return_log: nullableRound(rollingReturn, 6),
      rolling_momentum_pct: nullableRound(rollingReturn === null ? null : Math.expm1(rollingReturn) * 100, 3),
      raw_chained_index: nullableRound(nextRawIndex, 3),
      price_index: nullableRound(priceIndex, 3),
      published_return_log: nullableRound(publishedReturn, 6),
      liquidity_index: nullableRound(liquidity.index, 3),
      transaction_count: liquidity.currentCount,
      baseline_transaction_count: nullableRound(liquidity.baselineCount, 3),
      active_atom_count: diagnosticResult?.active_atom_count ?? 0,
      total_atom_count: diagnosticResult?.total_atom_count ?? 0,
      coverage: nullableRound(diagnosticResult?.coverage ?? 0, 4),
      matched_coverage: nullableRound(diagnosticResult?.matched_coverage ?? 0, 4),
      fallback_share: nullableRound(diagnosticResult?.fallback_share ?? 0, 4),
      top_block_weight: nullableRound(diagnosticResult?.top_block_weight ?? 0, 4),
      top_street_weight: nullableRound(diagnosticResult?.top_street_weight ?? 0, 4),
      block_count: diagnosticResult?.block_count ?? 0,
      street_count: diagnosticResult?.street_count ?? 0,
      floor_similarity_avg: nullableRound(diagnosticResult?.floor_similarity_avg ?? null, 4),
      floor_similarity_p25: nullableRound(diagnosticResult?.floor_similarity_p25 ?? null, 4),
      dispersion: nullableRound(diagnosticResult?.dispersion ?? null, 6),
      tier_atom_counts: diagnosticResult ? JSON.stringify(diagnosticResult.tier_atom_counts) : ""
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
    tierReturns.set(tier.tier, buildKernelReturnMap(currentRows, prevRows, tier.keyFn, tier.minN));
  }

  const fallbackReturns = universe.fallbackCellKeys.map((keyFn, index) => ({
    tier: ["fallback_town_flat_area_lease", "fallback_town_flat_lease", "fallback_town_flat"][index] ?? `fallback_${index}`,
    keyFn,
    returns: buildMedianReturnMap(currentRows, prevRows, keyFn, 8)
  }));
  const atoms = buildAtoms(weightRows);
  const totalAtomWeight = atoms.reduce((sum, atom) => sum + atom.weight, 0);
  if (totalAtomWeight <= 0) return null;

  const entries = [];
  for (const atom of atoms) {
    const decision = chooseReturn(atom.rep, tierReturns, fallbackReturns);
    if (!decision) continue;
    entries.push({
      atom,
      tier: decision.tier,
      raw_return: decision.result.return,
      return: clamp(decision.result.return, -RETURN_WINSOR_LOG, RETURN_WINSOR_LOG),
      floor_similarity_avg: decision.result.floor_similarity_avg,
      floor_similarity_p25: decision.result.floor_similarity_p25,
      base_weight: atom.weight,
      effective_weight: atom.weight * decision.multiplier,
      block: atom.rep._block_key,
      street: atom.rep._street_key,
      cell: universe.normalizedCellKey(atom.rep)
    });
  }
  if (!entries.length) return null;

  const cappedEntries = capBlockAndStreetWeights(entries);
  return aggregateNormalizedCellReturns(cappedEntries, weightRows, universe.normalizedCellKey, atoms.length);
}

function buildMedianReturnMap(currentRows, prevRows, keyFn, minN) {
  const current = groupRows(currentRows, keyFn);
  const previous = groupRows(prevRows, keyFn);
  const returns = new Map();
  for (const [key, currentGroup] of current.entries()) {
    const prevGroup = previous.get(key);
    if (!prevGroup || currentGroup.length < minN || prevGroup.length < minN) continue;
    const currentMedian = median(currentGroup.map((row) => row.price_psm));
    const prevMedian = median(prevGroup.map((row) => row.price_psm));
    if (currentMedian && prevMedian) {
      returns.set(key, {
        return: Math.log(currentMedian / prevMedian),
        floor_similarity_avg: null,
        floor_similarity_p25: null
      });
    }
  }
  return returns;
}

function buildKernelReturnMap(currentRows, prevRows, keyFn, minN) {
  const current = groupRows(currentRows, keyFn);
  const previous = groupRows(prevRows, keyFn);
  const returns = new Map();
  for (const [key, currentGroup] of current.entries()) {
    const prevGroup = previous.get(key);
    if (!prevGroup || currentGroup.length < minN || prevGroup.length < minN) continue;
    const result = floorKernelReturn(currentGroup, prevGroup);
    if (result) returns.set(key, result);
  }
  return returns;
}

function floorKernelReturn(currentRows, prevRows) {
  const prevByFloor = groupRows(prevRows, (row) => row._floor_key);
  const prevFloors = [...prevByFloor.keys()];
  const baselineByFloor = new Map();
  const similarityByFloor = new Map();
  const rowsByCurrentFloor = groupRows(currentRows, (row) => row._floor_key);
  const currentReturns = [];
  const floorSimilarities = [];

  for (const [floorKey, rows] of rowsByCurrentFloor.entries()) {
    if (!baselineByFloor.has(floorKey)) {
      const floorMid = rows[0]?._floor_mid ?? null;
      const weightedPrev = [];
      let similarityWeight = 0;
      let similarityTotal = 0;
      for (const prevFloor of prevFloors) {
        const prevRowsForFloor = prevByFloor.get(prevFloor) ?? [];
        const score = floorSimilarity(floorMid, prevRowsForFloor[0]?._floor_mid ?? null);
        similarityWeight += score * prevRowsForFloor.length;
        similarityTotal += prevRowsForFloor.length;
        for (const prevRow of prevRowsForFloor) weightedPrev.push({ value: prevRow.price_psm, weight: score });
      }
      baselineByFloor.set(floorKey, weightedMedian(weightedPrev));
      similarityByFloor.set(floorKey, similarityTotal ? similarityWeight / similarityTotal : null);
    }
    const baseline = baselineByFloor.get(floorKey);
    const similarity = similarityByFloor.get(floorKey);
    if (!baseline || !Number.isFinite(baseline)) continue;
    for (const row of rows) {
      currentReturns.push(Math.log(row.price_psm / baseline));
      if (Number.isFinite(similarity)) floorSimilarities.push(similarity);
    }
  }

  if (!currentReturns.length) return null;
  return {
    return: median(currentReturns),
    floor_similarity_avg: floorSimilarities.length ? floorSimilarities.reduce((sum, value) => sum + value, 0) / floorSimilarities.length : null,
    floor_similarity_p25: percentile(floorSimilarities, 0.25)
  };
}

function chooseReturn(row, tierReturns, fallbackReturns) {
  for (const tier of TIER_DEFS) {
    const result = tierReturns.get(tier.tier).get(tier.keyFn(row));
    if (result && Number.isFinite(result.return)) return { tier: tier.tier, result, multiplier: tier.multiplier };
  }
  for (const fallback of fallbackReturns) {
    const result = fallback.returns.get(fallback.keyFn(row));
    if (result && Number.isFinite(result.return)) return { tier: fallback.tier, result, multiplier: 1 };
  }
  return null;
}

function buildAtoms(weightRows) {
  const atoms = new Map();
  for (const row of weightRows) {
    const existing = atoms.get(row._atom_key);
    if (existing) {
      existing.weight += row.resale_price || 0;
    } else {
      atoms.set(row._atom_key, { key: row._atom_key, rep: row, weight: row.resale_price || 0 });
    }
  }
  return [...atoms.values()].filter((atom) => atom.weight > 0);
}

function capBlockAndStreetWeights(entries) {
  const withBlockCaps = capEntriesByGroup(entries, (entry) => entry.block, BLOCK_WEIGHT_CAP, "effective_weight", "block_capped_weight");
  return capEntriesByGroup(withBlockCaps, (entry) => entry.street, STREET_WEIGHT_CAP, "block_capped_weight", "capped_weight");
}

function capEntriesByGroup(entries, keyFn, capShare, inputField, outputField) {
  const byGroup = groupSum(entries, keyFn, (entry) => entry[inputField]);
  const cappedGroupWeights = capWeights(byGroup, capShare);
  return entries.map((entry) => {
    const groupWeight = byGroup.get(keyFn(entry)) ?? 0;
    const cappedGroupWeight = cappedGroupWeights.get(keyFn(entry)) ?? 0;
    const scale = groupWeight > 0 ? cappedGroupWeight / groupWeight : 0;
    return { ...entry, [outputField]: entry[inputField] * scale };
  });
}

function aggregateNormalizedCellReturns(entries, weightRows, cellKeyFn, totalAtomCount) {
  const cellWeights = groupSum(weightRows, cellKeyFn, (row) => row.resale_price || 0);
  const totalCellWeight = [...cellWeights.values()].reduce((sum, value) => sum + value, 0);
  if (totalCellWeight <= 0) return null;

  const entriesByCell = groupRows(entries, (entry) => entry.cell);
  const cells = [];
  const impliedBlockWeights = new Map();
  const impliedStreetWeights = new Map();

  for (const [cell, cellEntries] of entriesByCell.entries()) {
    const targetWeight = cellWeights.get(cell) ?? 0;
    const sourceWeight = cellEntries.reduce((sum, entry) => sum + entry.capped_weight, 0);
    if (targetWeight <= 0 || sourceWeight <= 0) continue;

    const cellReturn = cellEntries.reduce((sum, entry) => sum + entry.capped_weight * entry.return, 0) / sourceWeight;
    const fallbackSourceWeight = cellEntries
      .filter((entry) => isFallbackTier(entry.tier))
      .reduce((sum, entry) => sum + entry.capped_weight, 0);
    const matchedSourceWeight = sourceWeight - fallbackSourceWeight;

    for (const entry of cellEntries) {
      const impliedWeight = targetWeight * entry.capped_weight / sourceWeight;
      impliedBlockWeights.set(entry.block, (impliedBlockWeights.get(entry.block) ?? 0) + impliedWeight);
      impliedStreetWeights.set(entry.street, (impliedStreetWeights.get(entry.street) ?? 0) + impliedWeight);
    }

    cells.push({
      cell,
      target_weight: targetWeight,
      source_weight: sourceWeight,
      return: cellReturn,
      fallback_share: fallbackSourceWeight / sourceWeight,
      matched_share: matchedSourceWeight / sourceWeight,
      floor_similarity_avg: weightedAverage(cellEntries, (entry) => entry.floor_similarity_avg, (entry) => entry.capped_weight),
      floor_similarity_p25: weightedPercentile(cellEntries, (entry) => entry.floor_similarity_p25, (entry) => entry.capped_weight, 0.25)
    });
  }

  const activeCellWeight = cells.reduce((sum, cell) => sum + cell.target_weight, 0);
  if (activeCellWeight <= 0) return null;

  const weightedReturn = cells.reduce((sum, cell) => sum + cell.target_weight * cell.return, 0) / activeCellWeight;
  const fallbackShare = cells.reduce((sum, cell) => sum + cell.target_weight * cell.fallback_share, 0) / activeCellWeight;
  const matchedCoverage = cells.reduce((sum, cell) => sum + cell.target_weight * cell.matched_share, 0) / totalCellWeight;
  const topBlockWeight = Math.max(0, ...impliedBlockWeights.values()) / activeCellWeight;
  const topStreetWeight = Math.max(0, ...impliedStreetWeights.values()) / activeCellWeight;
  const returns = cells.map((cell) => cell.return);
  const medianReturn = median(returns);

  return {
    return: weightedReturn,
    coverage: activeCellWeight / totalCellWeight,
    matched_coverage: matchedCoverage,
    fallback_share: fallbackShare,
    top_block_weight: topBlockWeight,
    top_street_weight: topStreetWeight,
    active_atom_count: entries.length,
    total_atom_count: totalAtomCount,
    block_count: impliedBlockWeights.size,
    street_count: impliedStreetWeights.size,
    floor_similarity_avg: weightedAverage(cells, (cell) => cell.floor_similarity_avg, (cell) => cell.target_weight),
    floor_similarity_p25: weightedPercentile(cells, (cell) => cell.floor_similarity_p25, (cell) => cell.target_weight, 0.25),
    dispersion: median(returns.map((value) => Math.abs(value - medianReturn))),
    tier_atom_counts: objectFromMap(groupCounts(entries, (entry) => entry.tier))
  };
}

function computeLiquidity(rowsByMonth, windowMonths, weightMonths) {
  const currentCount = rowsForMonths(rowsByMonth, windowMonths).length;
  const rollingCounts = [];
  for (const month of weightMonths) rollingCounts.push(rowsForMonths(rowsByMonth, monthWindow(month, WINDOW_MONTHS)).length);
  const baselineCount = median(rollingCounts);
  return {
    currentCount,
    baselineCount,
    index: baselineCount ? (100 * currentCount) / baselineCount : null
  };
}

function confidenceFor(sampleSize, result) {
  if (!result || sampleSize < 20 || result.coverage < 0.25) return "None";
  if (result.top_block_weight > BLOCK_WEIGHT_CAP + 0.0005 || result.top_street_weight > STREET_WEIGHT_CAP + 0.0005) return "None";
  if (sampleSize < 50 || result.coverage < 0.45 || result.matched_coverage < 0.15 || result.fallback_share > 0.80) return "Low";
  if (sampleSize < 100 || result.coverage < 0.60 || result.matched_coverage < 0.30 || result.fallback_share > 0.65) return "Medium";
  return "High";
}

function buildAudit(rows, months, points, generatedAt) {
  return {
    generated_at: generatedAt,
    calculation_mode: "revised_backtest",
    method_version: "hdb-market-pulse-soft-match-v0.2",
    target_row_count: rows.length,
    first_month: months[0] ?? null,
    last_month: months.at(-1) ?? null,
    month_count: months.length,
    flat_type_counts: objectFromMap(groupCounts(rows, (row) => row.flat_type)),
    lease_bucket_counts: objectFromMap(groupCounts(rows, (row) => row._lease_bucket)),
    area_bucket_by_flat_type: [...groupCounts(rows, (row) => `${row.flat_type}|${row._area_bucket}`).entries()]
      .map(([key, count]) => {
        const [flat_type, area_bucket] = key.split("|");
        return { flat_type, area_bucket, count };
      }),
    flat_model_area_by_flat_type_top: buildFlatModelAreaAudit(rows)
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
    latest_points: latestByKey(points)
  };
}

function buildCellAudit(rows) {
  const specs = [
    ["month town x flat_type", (row) => `${row.month}|${row._town_flat_key}`],
    ["month town x flat_type x area10", (row) => `${row.month}|${row._town_flat_key}|${row._area_bucket}`],
    ["month town x flat_type x lease10", (row) => `${row.month}|${row._town_flat_key}|${row._lease_bucket}`],
    ["month town x flat_type x area10 x lease10", (row) => `${row.month}|${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`],
    ["month town x street x flat_type", (row) => `${row.month}|${row._street_key}`],
    ["month town x flat_type x floor", (row) => `${row.month}|${row._town_flat_key}|${row._floor_bucket}`],
    ["quarter town x flat_type", (row) => `${quarter(row.month)}|${row._town_flat_key}`],
    ["quarter town x flat_type x area10", (row) => `${quarter(row.month)}|${row._town_flat_key}|${row._area_bucket}`],
    ["quarter town x flat_type x lease10", (row) => `${quarter(row.month)}|${row._town_flat_key}|${row._lease_bucket}`],
    ["quarter town x flat_type x area10 x lease10", (row) => `${quarter(row.month)}|${row._town_flat_key}|${row._area_bucket}|${row._lease_bucket}`],
    ["quarter town x street x flat_type", (row) => `${quarter(row.month)}|${row._street_key}`],
    ["quarter town x flat_type x floor", (row) => `${quarter(row.month)}|${row._town_flat_key}|${row._floor_bucket}`]
  ];
  return specs.map(([cell_name, keyFn]) => {
    const counts = [...groupCounts(rows, keyFn).values()].sort((a, b) => a - b);
    const ge = (n) => counts.filter((count) => count >= n).length;
    return {
      cell_name,
      cells: counts.length,
      min: counts[0] ?? 0,
      p10: percentile(counts, 0.10),
      p25: percentile(counts, 0.25),
      median: median(counts),
      p75: percentile(counts, 0.75),
      p90: percentile(counts, 0.90),
      max: counts.at(-1) ?? 0,
      cells_ge_5: ge(5),
      share_ge_5: nullableRound(ge(5) / counts.length, 4),
      cells_ge_8: ge(8),
      share_ge_8: nullableRound(ge(8) / counts.length, 4),
      cells_ge_20: ge(20),
      share_ge_20: nullableRound(ge(20) / counts.length, 4)
    };
  });
}

function buildFlatModelAreaAudit(rows) {
  return [...groupCounts(rows, (row) => `${row.flat_type}|${row._flat_model_group}|${row._area_bucket}`).entries()]
    .map(([key, count]) => {
      const [flat_type, flat_model_group, area_bucket] = key.split("|");
      return { flat_type, flat_model_group, area_bucket, count };
    })
    .sort((a, b) => a.flat_type.localeCompare(b.flat_type) || a.flat_model_group.localeCompare(b.flat_model_group) || a.area_bucket.localeCompare(b.area_bucket));
}

function latestByKey(points) {
  const byKey = new Map();
  for (const point of points) {
    const current = byKey.get(point.index_key);
    if (!current || point.period_end_month > current.period_end_month) byKey.set(point.index_key, point);
  }
  return [...byKey.values()].sort((a, b) => a.index_key.localeCompare(b.index_key));
}

function latestPublishedByKey(points) {
  const byKey = new Map();
  for (const point of points) {
    if (point.price_index === null || point.price_index === undefined) continue;
    const current = byKey.get(point.index_key);
    if (!current || point.period_end_month > current.period_end_month) byKey.set(point.index_key, point);
  }
  return [...byKey.values()].sort((a, b) => a.index_key.localeCompare(b.index_key));
}

function remainingLeaseMonths(row) {
  const explicit = numberAt(row, "remaining_lease_months");
  if (explicit) return explicit;
  const raw = String(row.remaining_lease ?? "").trim();
  const years = raw.match(/(\d+)\s*years?/i)?.[1] ?? (/^\d+$/.test(raw) ? raw : null);
  const months = raw.match(/(\d+)\s*months?/i)?.[1] ?? 0;
  if (years !== null) return Number(years) * 12 + Number(months || 0);

  const leaseStart = numberAt(row, "lease_commence_date");
  const month = String(row.month ?? "");
  if (leaseStart && isValidMonth(month)) {
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    return (leaseStart + 99 - year) * 12 - (monthNumber - 1);
  }
  return null;
}

function leaseBucket10(months) {
  if (!Number.isFinite(months) || months <= 0) return "unknown";
  const years = months / 12;
  if (years < 40) return "<40";
  if (years < 50) return "40-49";
  if (years < 60) return "50-59";
  if (years < 70) return "60-69";
  if (years < 80) return "70-79";
  if (years < 90) return "80-89";
  return "90-99";
}

function areaBucket10(area) {
  if (!Number.isFinite(area)) return "unknown";
  const lower = Math.floor(area / 10) * 10;
  return `${lower}-${lower + 9}`;
}

function floorMidpoint(storeyRange) {
  const nums = String(storeyRange ?? "").match(/\d+/g)?.map(Number) ?? [];
  if (nums.length >= 2) return (nums[0] + nums[1]) / 2;
  return Number.isFinite(nums[0]) ? nums[0] : null;
}

function floorBucket(floorMid) {
  if (!Number.isFinite(floorMid)) return "unknown";
  if (floorMid <= 6) return "01-06";
  if (floorMid <= 12) return "07-12";
  if (floorMid <= 21) return "13-21";
  return "22+";
}

function floorSimilarity(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.5;
  return Math.exp(-Math.abs(a - b) / FLOOR_KERNEL_SCALE);
}

function flatModelGroupFor(value) {
  const text = canonicalText(value);
  if (text.includes("MODEL A")) return "MODEL_A";
  if (text.includes("IMPROVED")) return "IMPROVED";
  if (text.includes("NEW GENERATION")) return "NEW_GEN";
  if (text.includes("SIMPLIFIED")) return "SIMPLIFIED";
  if (text.includes("STANDARD")) return "STANDARD";
  if (text.includes("APARTMENT")) return "APARTMENT";
  if (text.includes("MAISONETTE")) return "MAISONETTE";
  if (text.includes("DBSS")) return "DBSS";
  if (text.includes("PREMIUM")) return "PREMIUM";
  return text ? "OTHER" : "UNKNOWN";
}

function isFallbackTier(tier) {
  return String(tier || "").startsWith("fallback_");
}

function numberAt(record, key) {
  const value = record[key];
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function keyPart(value) {
  return canonicalText(value).replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "UNKNOWN";
}

function sortFlatTypes(a, b) {
  return FLAT_TYPES.indexOf(a) - FLAT_TYPES.indexOf(b);
}

function quarter(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}-Q${Math.floor((monthNumber - 1) / 3) + 1}`;
}

function isQuarterEndMonth(month) {
  return ["03", "06", "09", "12"].includes(String(month).slice(5, 7));
}

function printHelp() {
  console.log(`Singapore HDB resale market pulse prototype

Usage:
  node research/hdb-market-pulse-index/build-hdb-pulse.mjs [options]

Options:
  --start-month <YYYY-MM>       Start month. Defaults to ${DEFAULT_START_MONTH}
  --end-month <YYYY-MM>         End month. Defaults to previous completed month
  --snapshot <path>             Normalized snapshot path. Defaults to ${snapshotPath}
  --use-existing-snapshot       Skip data.gov.sg pull and read --snapshot
  --include-town-flat           Also compute every town x flat_type series; slower
  --out <dir>                   Output directory. Defaults to ${DEFAULT_OUT_DIR}
  -h, --help                    Show this help
`);
}
