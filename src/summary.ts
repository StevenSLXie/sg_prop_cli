import type { SummaryMeta } from "./types.js";

export type NumericSummary = {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
};

export function numericSummary(values: number[]): NumericSummary {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, min: null, max: null, avg: null, median: null, p25: null, p75: null };
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: sum / sorted.length,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75)
  };
}

export function summaryMeta(sampleSize: number, rowsScanned: number, complete: boolean, truncated: boolean): SummaryMeta {
  return {
    summary_scope: complete ? "complete_matching_set" : "scanned_candidates",
    summary_rows_scanned: rowsScanned,
    summary_sample_size: sampleSize,
    summary_complete: complete,
    summary_truncated: truncated
  };
}

export function countBy(rows: Record<string, unknown>[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field] ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function percentile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}
