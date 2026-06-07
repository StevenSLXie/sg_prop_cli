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
const FALLBACK_WEIGHT_CAP = 0.45;
const RETURN_WINSOR_LOG = 0.12;
const FLOOR_KERNEL_SCALE = 10;

const SIZE_SEGMENTS = [
  { key: "compact", label: "<=800 sqft", minSqft: -Infinity, maxSqft: 800 },
  { key: "family", label: ">800-1200 sqft", minSqft: 800, maxSqft: 1200 },
  { key: "large", label: ">1200 sqft", minSqft: 1200, maxSqft: Infinity }
];

const RESALE_TIER_DEFS = [
  { tier: "project_size_floor_kernel", multiplier: 2, minN: 3, keyFn: (row) => row._project_size_key }
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
    method_version: "market-pulse-soft-match-v0.5",
    source_snapshot: snapshotPath,
    scope: {
      type_of_sale: ["resale", "new_sale"],
      property_type: ["Condominium", "Apartment"],
      excluded: ["sub_sale", "Executive Condominium", "landed", "resale_multi_unit_bulk_transactions"]
    },
    parameters: {
      window_months: WINDOW_MONTHS,
      weight_lookback_months: WEIGHT_LOOKBACK_MONTHS,
      min_weight_lookback_months: MIN_WEIGHT_LOOKBACK_MONTHS,
      project_weight_cap: PROJECT_WEIGHT_CAP,
      fallback_weight_cap: FALLBACK_WEIGHT_CAP,
      return_winsor_log: RETURN_WINSOR_LOG,
      floor_kernel_scale: FLOOR_KERNEL_SCALE,
      size_segments: SIZE_SEGMENTS.map(({ key, label, minSqft, maxSqft }) => ({ key, label, minSqft, maxSqft })),
      tenure_buckets: ["freehold_999", "leasehold", "unknown"],
      resale_tiers: [
        { tier: "project_size_floor_kernel", weight_multiplier: 2, min_current_and_previous_rows: 3, project_key: "district_project_street" },
        { tier: "fallback_cell_floor_kernel", weight_multiplier: 1, min_current_and_previous_rows: 8, primary_cell: "universe_cell_tenure", secondary_cell: "universe_cell" }
      ],
      new_sale_tiers: [
        { tier: "fallback_cell_floor_kernel", weight_multiplier: 1, min_current_and_previous_rows: 8 }
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
  const saleTypes = ["resale", "new_sale"];
  const universes = [];

  for (const saleType of saleTypes) {
    const prefix = saleType === "resale" ? "SG_CONDO_RESALE" : "SG_CONDO_NEW_SALE";
    const saleLabel = saleType === "resale" ? "resale" : "new_sale";
    const tiers = saleType === "resale" ? RESALE_TIER_DEFS : [];
    universes.push({
      key: `${prefix}_OVERALL`,
      type: "overall",
      sale_type: saleLabel,
      tiers,
      filter: (row) => row.type_of_sale === saleType,
      fallbackCellKeys: [
        (row) => `${row.district || "unknown"}|${row._size_key}|${row._tenure_bucket}`,
        (row) => `${row.district || "unknown"}|${row._size_key}`
      ]
    });

    for (const segment of segments) {
      universes.push({
        key: `${prefix}_${segment}`,
        type: "market_segment",
        sale_type: saleLabel,
        market_segment: segment,
        tiers,
        filter: (row) => row.type_of_sale === saleType && row.market_segment === segment,
        fallbackCellKeys: [
          (row) => `${row.district || "unknown"}|${row._size_key}|${row._tenure_bucket}`,
          (row) => `${row.district || "unknown"}|${row._size_key}`
        ]
      });
    }

    if (options.coreOnly) continue;

    for (const district of districts) {
      universes.push({
        key: `${prefix}_D${district}`,
        type: "district",
        sale_type: saleLabel,
        district,
        tiers,
        filter: (row) => row.type_of_sale === saleType && row.district === district,
        fallbackCellKeys: [
          (row) => `${row._size_key}|${row._tenure_bucket}`,
          (row) => row._size_key
        ]
      });
    }

    for (const segment of SIZE_SEGMENTS) {
      universes.push({
        key: `${prefix}_SIZE_${segment.key.toUpperCase()}`,
        type: "size_segment",
        sale_type: saleLabel,
        size_segment: segment.key,
        tiers,
        filter: (row) => row.type_of_sale === saleType && row._size_key === segment.key,
        fallbackCellKeys: [
          (row) => `${row.market_segment || "unknown"}|${row._tenure_bucket}`,
          (row) => row.market_segment || "unknown"
        ]
      });
    }
  }

  return universes;
}

function computeUniversePoints(allRows, months, universe, pulledAt) {
  const rows = allRows.filter(universe.filter);
  const rowsByMonth = groupRows(rows, (row) => row.contract_month);
  const points = [];
  let rawIndex = null;
  let publicIndex = null;
  let publicSegment = 0;

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
    const confidence = confidenceFor(sampleSize, result, universe);
    const priceReturn = result?.return ?? null;
    const nextRawIndex = priceReturn === null ? null : rawIndex === null ? 100 : rawIndex * Math.exp(priceReturn);
    if (nextRawIndex !== null) rawIndex = nextRawIndex;
    const startsNewSegment = priceReturn !== null && confidence !== "None" && publicIndex === null;
    if (startsNewSegment) publicSegment += 1;
    const priceIndex = priceReturn === null || confidence === "None" ? null : startsNewSegment ? 100 : publicIndex * Math.exp(priceReturn);
    if (priceIndex !== null) publicIndex = priceIndex;

    points.push({
      index_key: universe.key,
      universe_type: universe.type,
      market_segment: universe.market_segment ?? "",
      district: universe.district ?? "",
      size_segment: universe.size_segment ?? "",
      sale_type: universe.sale_type ?? "",
      period_end_month: endMonth,
      window_start_month: windowMonths[0],
      window_end_month: windowMonths.at(-1),
      as_of_date: pulledAt,
      calculation_mode: "revised_backtest",
      provisional: false,
      method_version: "market-pulse-soft-match-v0.5",
      sample_size: sampleSize,
      confidence,
      price_return_log: nullableRound(priceReturn, 6),
      rolling_momentum_pct: nullableRound(priceReturn === null ? null : Math.expm1(priceReturn) * 100, 3),
      raw_chained_index: nullableRound(nextRawIndex, 3),
      price_index: nullableRound(priceIndex, 3),
      price_index_segment: priceIndex === null ? null : publicSegment,
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
      floor_similarity_avg: nullableRound(result?.floor_similarity_avg ?? null, 4),
      floor_similarity_p25: nullableRound(result?.floor_similarity_p25 ?? null, 4),
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

  const tierDefs = universe.tiers ?? RESALE_TIER_DEFS;
  const fallbackKeyFns = fallbackCellKeyFns(universe);
  if (tierDefs.length === 0) {
    return computeFallbackOnlyReturn(currentRows, prevRows, prevRows, fallbackKeyFns, { useFloorKernel: false });
  }

  const tierReturns = new Map();
  for (const tier of tierDefs) {
    tierReturns.set(tier.tier, buildKernelReturnMap(currentRows, prevRows, tier.keyFn, tier.minN));
  }
  const fallbackReturns = fallbackKeyFns.map((keyFn, index) => ({
    tier: index === 0 ? "fallback_cell_tenure" : "fallback_cell",
    keyFn,
    returns: buildKernelReturnMap(currentRows, prevRows, keyFn, 8)
  }));
  const atoms = buildAtoms(weightRows);
  const totalAtomWeight = atoms.reduce((sum, atom) => sum + atom.weight, 0);
  if (totalAtomWeight <= 0) return null;

  const entries = [];
  for (const atom of atoms) {
    const decision = chooseReturn(atom.rep, tierDefs, tierReturns, fallbackReturns);
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
      project: atom.rep._project_key
    });
  }
  if (!entries.length) return null;

  const cappedEntries = universe.type === "district"
    ? capFallbackWeights(capProjectWeights(entries), FALLBACK_WEIGHT_CAP)
    : capProjectWeights(entries);
  const totalEffectiveWeight = cappedEntries.reduce((sum, entry) => sum + entry.capped_weight, 0);
  if (totalEffectiveWeight <= 0) return null;

  const weightedReturn = cappedEntries.reduce((sum, entry) => sum + entry.capped_weight * entry.return, 0) / totalEffectiveWeight;
  const activeAtomWeight = entries.reduce((sum, entry) => sum + entry.base_weight, 0);
  const matchedAtomWeight = entries
    .filter((entry) => !isFallbackTier(entry.tier))
    .reduce((sum, entry) => sum + entry.base_weight, 0);
  const fallbackEffectiveWeight = cappedEntries
    .filter((entry) => isFallbackTier(entry.tier))
    .reduce((sum, entry) => sum + entry.capped_weight, 0);
  const projectWeights = groupSum(cappedEntries, (entry) => entry.project, (entry) => entry.capped_weight);
  const topProjectWeight = Math.max(0, ...projectWeights.values()) / totalEffectiveWeight;
  const tierAtomCounts = groupCounts(entries, (entry) => entry.tier);
  const returns = cappedEntries.map((entry) => entry.return);
  const medianReturn = median(returns);
  const floorSimilarityAvg = weightedAverage(cappedEntries, (entry) => entry.floor_similarity_avg, (entry) => entry.capped_weight);
  const floorSimilarityP25 = weightedPercentile(cappedEntries, (entry) => entry.floor_similarity_p25, (entry) => entry.capped_weight, 0.25);

  return {
    return: weightedReturn,
    coverage: activeAtomWeight / totalAtomWeight,
    matched_coverage: matchedAtomWeight / totalAtomWeight,
    fallback_share: fallbackEffectiveWeight / totalEffectiveWeight,
    top_project_weight: topProjectWeight,
    active_atom_count: entries.length,
    total_atom_count: atoms.length,
    project_count: projectWeights.size,
    floor_similarity_avg: floorSimilarityAvg,
    floor_similarity_p25: floorSimilarityP25,
    dispersion: median(returns.map((value) => Math.abs(value - medianReturn))),
    tier_atom_counts: objectFromMap(tierAtomCounts)
  };
}

function computeFallbackOnlyReturn(currentRows, prevRows, weightRows, cellKeyFns, options = {}) {
  const keyFns = Array.isArray(cellKeyFns) ? cellKeyFns : [cellKeyFns];
  const returnMaps = keyFns.map((keyFn, index) => ({
    tier: index === 0 ? "fallback_cell_tenure" : "fallback_cell",
    keyFn,
    returns: options.useFloorKernel
      ? buildKernelReturnMap(currentRows, prevRows, keyFn, 8)
      : buildMedianReturnMap(currentRows, prevRows, keyFn, 8)
  }));
  const cells = buildCellAtoms(weightRows, keyFns[0]);
  const totalWeight = cells.reduce((sum, cell) => sum + cell.weight, 0);
  if (totalWeight <= 0) return null;

  const entries = [];
  for (const cell of cells) {
    let decision = null;
    for (const map of returnMaps) {
      const result = map.returns.get(map.keyFn(cell.rep));
      if (result && Number.isFinite(result.return)) {
        decision = { tier: map.tier, result };
        break;
      }
    }
    if (!decision) continue;
    entries.push({
      cell: cell.key,
      tier: decision.tier,
      weight: cell.weight,
      return: clamp(decision.result.return, -RETURN_WINSOR_LOG, RETURN_WINSOR_LOG),
      floor_similarity_avg: decision.result.floor_similarity_avg,
      floor_similarity_p25: decision.result.floor_similarity_p25
    });
  }
  const activeWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (activeWeight <= 0) return null;
  const weightedReturn = entries.reduce((sum, entry) => sum + entry.weight * entry.return, 0) / activeWeight;
  const returns = entries.map((entry) => entry.return);
  const medianReturn = median(returns);
  return {
    return: weightedReturn,
    coverage: activeWeight / totalWeight,
    matched_coverage: 0,
    fallback_share: 1,
    top_project_weight: 0,
    active_atom_count: entries.length,
    total_atom_count: cells.length,
    project_count: 0,
    floor_similarity_avg: weightedAverage(entries, (entry) => entry.floor_similarity_avg, (entry) => entry.weight),
    floor_similarity_p25: weightedPercentile(entries, (entry) => entry.floor_similarity_p25, (entry) => entry.weight, 0.25),
    dispersion: median(returns.map((value) => Math.abs(value - medianReturn))),
    tier_atom_counts: objectFromMap(groupCounts(entries, (entry) => entry.tier))
  };
}

function buildMedianReturnMap(currentRows, prevRows, keyFn, minN) {
  const current = groupRows(currentRows, keyFn);
  const previous = groupRows(prevRows, keyFn);
  const returns = new Map();
  for (const [key, currentGroup] of current.entries()) {
    const prevGroup = previous.get(key);
    if (!prevGroup || currentGroup.length < minN || prevGroup.length < minN) continue;
    const currentMedian = median(currentGroup.map((row) => row.price_psf));
    const prevMedian = median(prevGroup.map((row) => row.price_psf));
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

function chooseReturn(row, tierDefs, tierReturns, fallbackReturns) {
  for (const tier of tierDefs) {
    const result = tierReturns.get(tier.tier).get(tier.keyFn(row));
    if (result && Number.isFinite(result.return)) return { tier: tier.tier, result, multiplier: tier.multiplier };
  }
  for (const fallback of fallbackReturns) {
    const result = fallback.returns.get(fallback.keyFn(row));
    if (result && Number.isFinite(result.return)) return { tier: fallback.tier, result, multiplier: 1 };
  }
  return null;
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
        for (const prevRow of prevRowsForFloor) weightedPrev.push({ value: prevRow.price_psf, weight: score });
      }
      baselineByFloor.set(floorKey, weightedMedian(weightedPrev));
      similarityByFloor.set(floorKey, similarityTotal ? similarityWeight / similarityTotal : null);
    }
    const baseline = baselineByFloor.get(floorKey);
    const similarity = similarityByFloor.get(floorKey);
    if (!baseline || !Number.isFinite(baseline)) continue;
    for (const row of rows) {
      currentReturns.push(Math.log(row.price_psf / baseline));
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

function buildCellAtoms(weightRows, keyFn) {
  const cells = new Map();
  for (const row of weightRows) {
    const key = keyFn(row);
    const existing = cells.get(key);
    if (existing) {
      existing.weight += row.price || 0;
    } else {
      cells.set(key, { key, rep: row, weight: row.price || 0 });
    }
  }
  return [...cells.values()].filter((cell) => cell.weight > 0);
}

function capProjectWeights(entries) {
  const byProject = groupSum(entries, (entry) => entry.project, (entry) => entry.effective_weight);
  const cappedProjectWeights = capWeights(byProject, PROJECT_WEIGHT_CAP);
  return entries.map((entry) => {
    const projectWeight = byProject.get(entry.project) ?? 0;
    const cappedProjectWeight = cappedProjectWeights.get(entry.project) ?? 0;
    const scale = projectWeight > 0 ? cappedProjectWeight / projectWeight : 0;
    return { ...entry, capped_weight: entry.effective_weight * scale };
  });
}

function capFallbackWeights(entries, capShare) {
  const fallbackWeight = entries
    .filter((entry) => isFallbackTier(entry.tier))
    .reduce((sum, entry) => sum + entry.capped_weight, 0);
  const nonFallbackWeight = entries
    .filter((entry) => !isFallbackTier(entry.tier))
    .reduce((sum, entry) => sum + entry.capped_weight, 0);
  const total = fallbackWeight + nonFallbackWeight;
  if (total <= 0 || fallbackWeight <= 0 || nonFallbackWeight <= 0 || fallbackWeight / total <= capShare) return entries;

  const fallbackScale = (capShare * nonFallbackWeight) / (fallbackWeight * (1 - capShare));
  return entries.map((entry) => isFallbackTier(entry.tier)
    ? { ...entry, capped_weight: entry.capped_weight * fallbackScale }
    : entry);
}

function fallbackCellKeyFns(universe) {
  if (Array.isArray(universe.fallbackCellKeys) && universe.fallbackCellKeys.length) return universe.fallbackCellKeys;
  if (universe.fallbackCellKey) return [universe.fallbackCellKey];
  return [(row) => `${row.district || "unknown"}|${row._size_key}`];
}

function isFallbackTier(tier) {
  return String(tier || "").startsWith("fallback_cell");
}

function confidenceFor(sampleSize, result, universe = {}) {
  if (!result || sampleSize < 25 || result.coverage < 0.25) return "None";
  if (result.top_project_weight > PROJECT_WEIGHT_CAP + 0.0005) return "None";
  if (universe.sale_type === "resale" && universe.type === "district" && result.fallback_share > 0.7) return "None";
  if (universe.sale_type === "resale" && result.fallback_share > 0.95) return "None";
  if (sampleSize < 50 || result.coverage < 0.4 || result.matched_coverage < 0.25 || result.fallback_share > 0.55 || result.top_project_weight > 0.35) return "Low";
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
    method_version: "market-pulse-soft-match-v0.5",
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
    (row.type_of_sale === "resale" || row.type_of_sale === "new_sale") &&
    (row.type_of_sale !== "resale" || row.no_of_units === 1) &&
    (row.property_type === "Condominium" || row.property_type === "Apartment") &&
    isValidMonth(row.contract_month) &&
    row.area_sqm > 0 &&
    row.price > 0 &&
    row.price_psf > 0
  );
}

function enrichRow(row) {
  const sizeKey = sizeSegment(row).key;
  const tenureKey = tenureBucket(row.tenure);
  const project = projectKey(row);
  const floorKey = normalizeFloorKey(row.floor_range);
  const floorMid = floorMidpoint(floorKey);
  return {
    ...row,
    _size_key: sizeKey,
    _tenure_bucket: tenureKey,
    _project_key: project,
    _project_size_key: `${project}|${sizeKey}`,
    _floor_key: floorKey,
    _floor_mid: floorMid,
    _atom_key: `${project}|${sizeKey}`
  };
}

function atomKey(row) {
  return row._atom_key ?? `${projectKey(row)}|${sizeSegment(row).key}`;
}

function projectKey(row) {
  return `${row.district || "unknown"}|${canonicalText(row.project) || "unknown"}|${canonicalText(row.street) || "unknown"}`;
}

function normalizeFloorKey(value) {
  return String(value || "unknown").trim().toUpperCase() || "unknown";
}

function canonicalText(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

function tenureBucket(value) {
  const text = canonicalText(value);
  if (!text || text === "-") return "unknown";
  if (text.includes("FREEHOLD") || /\b999\s*YRS\b/.test(text)) return "freehold_999";
  return "leasehold";
}

function floorMidpoint(value) {
  const text = normalizeFloorKey(value);
  const match = /^(\d+)-(\d+)$/.exec(text);
  if (match) return (Number(match[1]) + Number(match[2])) / 2;
  const basement = /^B(\d+)-B(\d+)$/.exec(text);
  if (basement) return -((Number(basement[1]) + Number(basement[2])) / 2);
  return null;
}

function floorSimilarity(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.5;
  return Math.exp(-Math.abs(a - b) / FLOOR_KERNEL_SCALE);
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

function capWeights(weightByKey, capShare) {
  const total = [...weightByKey.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0 || capShare <= 0) return new Map([...weightByKey.keys()].map((key) => [key, 0]));

  const absoluteCap = total * capShare;
  const capped = new Map();
  const remaining = new Map([...weightByKey.entries()].filter(([, value]) => value > 0));
  let remainingOriginalWeight = total;
  let remainingCappedWeight = total;

  while (remaining.size) {
    const newlyCapped = [];
    for (const [key, weight] of remaining.entries()) {
      const redistributedWeight = remainingOriginalWeight > 0 ? (remainingCappedWeight * weight) / remainingOriginalWeight : 0;
      if (redistributedWeight > absoluteCap) newlyCapped.push([key, weight]);
    }
    if (!newlyCapped.length) break;

    for (const [key, weight] of newlyCapped) {
      capped.set(key, absoluteCap);
      remaining.delete(key);
      remainingOriginalWeight -= weight;
      remainingCappedWeight -= absoluteCap;
    }
    if (remainingOriginalWeight <= 0 || remainingCappedWeight <= 0) break;
  }

  for (const [key, weight] of remaining.entries()) {
    const redistributedWeight = remainingOriginalWeight > 0 ? (remainingCappedWeight * weight) / remainingOriginalWeight : 0;
    capped.set(key, redistributedWeight);
  }
  return capped;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

function weightedMedian(items) {
  const sorted = items
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= totalWeight / 2) return item.value;
  }
  return sorted.at(-1).value;
}

function weightedAverage(items, valueFn, weightFn) {
  let totalWeight = 0;
  let totalValue = 0;
  for (const item of items) {
    const value = valueFn(item);
    const weight = weightFn(item);
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    totalValue += value * weight;
    totalWeight += weight;
  }
  return totalWeight ? totalValue / totalWeight : null;
}

function weightedPercentile(items, valueFn, weightFn, p) {
  const sorted = items
    .map((item) => ({ value: valueFn(item), weight: weightFn(item) }))
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= totalWeight * p) return item.value;
  }
  return sorted.at(-1).value;
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
