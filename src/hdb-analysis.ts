import { analyzeRows, type AnalysisOutputMode, type AnalysisSegment } from "./analysis-engine.js";
import { DataGovClient } from "./datagov-client.js";
import { exactServerFilters, normalizeDataGovFilterValues, planDataGovScan } from "./datagov-planner.js";
import { rowMatchesFilters, resolveFilterAliases } from "./filters.js";
import { normalizeRow } from "./query.js";
import { requireSource } from "./registry.js";
import type { HousingFilters } from "./types.js";

export type HdbAnalysisSegmentSpec = {
  name: string;
  filters?: HousingFilters;
};

export type HdbResaleAnalysisInput = {
  filters?: HousingFilters;
  group_by?: string[];
  segments?: HdbAnalysisSegmentSpec[];
  metrics?: string[];
  output?: AnalysisOutputMode;
  limit_rows_scanned?: number;
  max_output_rows?: number;
  max_output_columns?: number;
};

export type HdbResaleAnalysisScan = {
  rows: Record<string, unknown>[];
  rows_scanned: number;
  pages_scanned: number;
  backend_total: number | null;
  complete: boolean;
  dataset_ids: string[];
  server_filters?: Record<string, string | number | Array<string | number>>;
  filters?: HousingFilters;
};

export type HdbResaleAnalysisResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  scan: HdbResaleAnalysisScan;
};

const SOURCE_KEY = "hdb_resale_transactions";
const PAGE_SIZE = 500;
const DEFAULT_SCAN_LIMIT = 5000;
const MAX_SCAN_LIMIT = 20000;

export async function scanHdbResaleAnalysisRows(input: HdbResaleAnalysisInput, client = new DataGovClient()): Promise<HdbResaleAnalysisScan> {
  const source = requireSource(SOURCE_KEY);
  const filters = normalizeHdbAnalysisFilters(resolveFilterAliases(source.fields, input.filters));
  const datasetIds = source.dataset_ids ?? [];
  const scanPlan = planDataGovScan(source.source_key, datasetIds, filters);
  const scanLimit = clamp(input.limit_rows_scanned ?? DEFAULT_SCAN_LIMIT, 1, MAX_SCAN_LIMIT);
  const serverFilters = exactServerFilters(source.source_key, filters);
  const rows: Record<string, unknown>[] = [];
  let rowsScanned = 0;
  let pagesScanned = 0;
  let backendTotal: number | null = null;
  let complete = true;

  outer: for (const datasetId of scanPlan.datasetIds) {
    let offset = 0;
    for (;;) {
      if (rowsScanned >= scanLimit) {
        complete = false;
        break outer;
      }
      const remaining = scanLimit - rowsScanned;
      const response = await client.searchRows({
        resourceId: datasetId,
        limit: Math.min(PAGE_SIZE, remaining),
        offset,
        filters: serverFilters,
        sort: scanPlan.sort
      });
      pagesScanned += 1;
      backendTotal = response.total;
      rowsScanned += response.records.length;
      let shouldStopAfterPage = false;

      for (const rawRow of response.records) {
        const row = deriveHdbResaleAnalysisFields(normalizeRow(rawRow, source.fields));
        if (scanPlan.stopAfterFieldBelow && isBelowStopValue(row, scanPlan.stopAfterFieldBelow)) shouldStopAfterPage = true;
        if (!rowMatchesFilters(row, filters)) continue;
        rows.push(row);
      }

      offset += response.records.length;
      if (shouldStopAfterPage) break outer;
      if (response.records.length === 0 || (response.total !== null && offset >= response.total)) break;
    }
  }

  return {
    rows,
    rows_scanned: rowsScanned,
    pages_scanned: pagesScanned,
    backend_total: backendTotal,
    complete,
    dataset_ids: scanPlan.datasetIds,
    server_filters: serverFilters,
    filters
  };
}

export async function analyzeHdbResaleRows(input: HdbResaleAnalysisInput, client = new DataGovClient()): Promise<HdbResaleAnalysisResult> {
  const scan = await scanHdbResaleAnalysisRows(input, client);
  const result = analyzeRows({
    rows: scan.rows,
    groupBy: input.group_by?.length ? input.group_by : ["town", "flat_type", "quarter"],
    segments: buildSegments(input.segments),
    metrics: input.metrics?.length ? input.metrics : ["count", "resale_price_median", "price_psm_median", "floor_area_sqm_median"],
    output: input.output ?? "long_table",
    maxOutputRows: input.max_output_rows ?? 300,
    maxOutputColumns: input.max_output_columns ?? 60
  });
  return { ...result, scan };
}

export function normalizeHdbAnalysisFilters(filters: HousingFilters | undefined): HousingFilters | undefined {
  return normalizeDataGovFilterValues(SOURCE_KEY, filters);
}

export function deriveHdbResaleAnalysisFields(row: Record<string, unknown>): Record<string, unknown> {
  const month = typeof row.month === "string" ? row.month : String(row.month ?? "");
  const year = /^\d{4}-\d{2}$/.test(month) ? month.slice(0, 4) : null;
  const monthNumber = /^\d{4}-\d{2}$/.test(month) ? Number(month.slice(5, 7)) : null;
  const resalePrice = toFiniteNumber(row.resale_price);
  const floorAreaSqm = toFiniteNumber(row.floor_area_sqm);
  const remainingLeaseMonths = toFiniteNumber(row.remaining_lease_months);
  return {
    ...row,
    year,
    quarter: year && monthNumber ? `${year}-Q${Math.ceil(monthNumber / 3)}` : null,
    remaining_lease_bucket: remainingLeaseMonths === null ? null : remainingLeaseBucket(remainingLeaseMonths),
    price_psm: resalePrice !== null && floorAreaSqm && floorAreaSqm > 0 ? resalePrice / floorAreaSqm : null
  };
}

export function remainingLeaseBucket(months: number): string {
  const start = Math.floor(months / 120) * 120;
  const end = start + 119;
  return `${String(start).padStart(3, "0")}-${String(end).padStart(3, "0")} months`;
}

function buildSegments(specs: HdbAnalysisSegmentSpec[] | undefined): AnalysisSegment<Record<string, unknown>>[] {
  if (!specs?.length) return [{ name: "all" }];
  return specs.map((segment) => {
    const filters = normalizeHdbAnalysisFilters(segment.filters);
    return {
      name: segment.name,
      matches: filters ? (row) => rowMatchesFilters(row, filters) : undefined
    };
  });
}

function isBelowStopValue(row: Record<string, unknown>, stop: { field: string; value: string }): boolean {
  const actual = row[stop.field];
  if (actual === null || actual === undefined) return false;
  return String(actual) < stop.value;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
