import { AnalysisEngineError, analyzeRows, type AnalysisOutputMode, type AnalysisSegment } from "./analysis-engine.js";
import { analysisField, validateAnalysisInput } from "./analysis-validation.js";
import { DataGovClient, DataGovError } from "./datagov-client.js";
import { exactServerFilters, normalizeDataGovFilterValues, normalizeHdbFlatType, planDataGovScan } from "./datagov-planner.js";
import { baseMeta, fail, ok, sourceAttribution } from "./envelope.js";
import { rowMatchesFilters, resolveFilterAliases } from "./filters.js";
import { normalizeRow } from "./query.js";
import { requireSource } from "./registry.js";
import type { HousingFilters, ResultEnvelope } from "./types.js";

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
  allow_partial?: boolean;
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

export type AnalyzeHdbResaleTransactionsData = {
  columns: string[];
  rows: Record<string, unknown>[];
  assumptions: Record<string, unknown>[];
  diagnostics: Record<string, unknown>;
  partial?: boolean;
};

const SOURCE_KEY = "hdb_resale_transactions";
const TOOL = "analyze_hdb_resale_transactions";
const PAGE_SIZE = 500;
const DEFAULT_SCAN_LIMIT = 5000;
const MAX_SCAN_LIMIT = 20000;

export async function scanHdbResaleAnalysisRows(input: HdbResaleAnalysisInput, client = new DataGovClient()): Promise<HdbResaleAnalysisScan> {
  const source = requireSource(SOURCE_KEY);
  const filters = normalizeHdbAnalysisFilters(resolveFilterAliases(source.fields, input.filters));
  const validationErrors = validateHdbAnalysisRequest(input, filters, source.fields);
  if (validationErrors.length > 0) {
    throw new AnalysisEngineError("VALIDATION_ERROR", validationErrors.join(" "));
  }
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
  const result = materializeHdbResaleAnalysis(input, scan);
  return { ...result, scan };
}

export async function analyzeHdbResaleTransactions(
  input: HdbResaleAnalysisInput,
  client = new DataGovClient()
): Promise<ResultEnvelope<AnalyzeHdbResaleTransactionsData>> {
  const source = requireSource(SOURCE_KEY);
  try {
    const scan = await scanHdbResaleAnalysisRows(input, client);
    const meta = {
      ...baseMeta([SOURCE_KEY], [sourceAttribution(source, scan.dataset_ids[0])], source.caveats),
      rows_returned: 0,
      rows_scanned: scan.rows_scanned,
      pages_scanned: scan.pages_scanned,
      backend_total: scan.backend_total,
      complete: scan.complete,
      truncated: !scan.complete,
      next_cursor: null
    };

    if (!scan.complete && !input.allow_partial) {
      return fail(TOOL, "SCAN_LIMIT_REACHED", "HDB resale analysis scan cap was reached before the matching set was complete.", "Narrow filters or set allow_partial=true to inspect an explicitly partial table.", {
        affected_sources: [SOURCE_KEY],
        partial: { meta }
      });
    }

    const result = materializeHdbResaleAnalysis(input, scan);
    const data = {
      ...result,
      assumptions: [],
      diagnostics: diagnostics(input, scan),
      ...(scan.complete ? {} : { partial: true })
    };
    return ok(TOOL, data, {
      ...meta,
      rows_returned: result.rows.length
    });
  } catch (error) {
    if (error instanceof AnalysisEngineError) {
      return fail(TOOL, error.code, error.message, "Reduce groups, segments, or metrics, or raise output caps within documented limits.", {
        affected_sources: [SOURCE_KEY]
      });
    }
    if (error instanceof DataGovError) {
      return fail(TOOL, error.code, error.message, "Retry later or narrow the query.", {
        recoverable: true,
        affected_sources: [SOURCE_KEY]
      });
    }
    return fail(TOOL, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error), "Retry or report the issue.", {
      affected_sources: [SOURCE_KEY]
    });
  }
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

function materializeHdbResaleAnalysis(input: HdbResaleAnalysisInput, scan: HdbResaleAnalysisScan) {
  const source = requireSource(SOURCE_KEY);
  const groupBy = input.group_by?.length ? input.group_by : ["town", "flat_type", "quarter"];
  const metrics = input.metrics?.length ? input.metrics : ["count", "resale_price_median", "price_psm_median", "floor_area_sqm_median"];
  const segments = normalizeSegments(input.segments, source.fields);
  return analyzeRows({
    rows: scan.rows,
    groupBy,
    segments: buildSegments(segments),
    metrics,
    output: input.output ?? "long_table",
    maxOutputRows: input.max_output_rows ?? 300,
    maxOutputColumns: input.max_output_columns ?? 60
  });
}

function diagnostics(input: HdbResaleAnalysisInput, scan: HdbResaleAnalysisScan): Record<string, unknown> {
  const groupBy = input.group_by?.length ? input.group_by : ["town", "flat_type", "quarter"];
  const metrics = input.metrics?.length ? input.metrics : ["count", "resale_price_median", "price_psm_median", "floor_area_sqm_median"];
  return {
    dataset_ids: scan.dataset_ids,
    server_filters: scan.server_filters ?? null,
    filters: scan.filters ?? null,
    matching_rows: scan.rows.length,
    group_by: groupBy,
    metrics,
    output: input.output ?? "long_table",
    scan_complete: scan.complete
  };
}

export function remainingLeaseBucket(months: number): string {
  const start = Math.floor(months / 120) * 120;
  const end = start + 119;
  return `${String(start).padStart(3, "0")}-${String(end).padStart(3, "0")} months`;
}

function validateHdbAnalysisRequest(input: HdbResaleAnalysisInput, filters: HousingFilters | undefined, fields: ReturnType<typeof requireSource>["fields"]): string[] {
  const groupBy = input.group_by?.length ? input.group_by : ["town", "flat_type", "quarter"];
  const metrics = input.metrics?.length ? input.metrics : ["count", "resale_price_median", "price_psm_median", "floor_area_sqm_median"];
  const segments = normalizeSegments(input.segments, fields);
  return [
    ...validateAnalysisInput({
      fields,
      derivedFields: hdbDerivedFields(),
      groupBy,
      metrics,
      filters: [filters, ...segments.map((segment) => segment.filters)].filter((item): item is HousingFilters => Boolean(item))
    }),
    ...validateFlatTypes([filters, ...segments.map((segment) => segment.filters)])
  ];
}

function normalizeSegments(specs: HdbAnalysisSegmentSpec[] | undefined, fields: ReturnType<typeof requireSource>["fields"]): HdbAnalysisSegmentSpec[] {
  return (specs ?? []).map((segment) => ({
    ...segment,
    filters: normalizeHdbAnalysisFilters(resolveFilterAliases(fields, segment.filters))
  }));
}

function buildSegments(specs: HdbAnalysisSegmentSpec[] | undefined): AnalysisSegment<Record<string, unknown>>[] {
  if (!specs?.length) return [{ name: "all" }];
  return specs.map((segment) => ({
    name: segment.name,
    matches: segment.filters ? (row) => rowMatchesFilters(row, segment.filters) : undefined
  }));
}

function hdbDerivedFields() {
  return [
    analysisField("quarter", "quarter", ["eq", "in", "gte", "lte"]),
    analysisField("year", "string", ["eq", "in", "gte", "lte"]),
    analysisField("remaining_lease_bucket", "string", ["eq", "in"]),
    analysisField("price_psm", "number", ["eq", "gte", "lte"])
  ];
}

function validateFlatTypes(filtersList: Array<HousingFilters | undefined>): string[] {
  const allowed = new Set(["1 ROOM", "2 ROOM", "3 ROOM", "4 ROOM", "5 ROOM", "EXECUTIVE", "MULTI-GENERATION"]);
  const errors: string[] = [];
  for (const filters of filtersList) {
    if (!filters) continue;
    for (const [field, condition] of Object.entries(filters)) {
      const base = field.replace(/_(gte|lte)$/, "");
      if (base !== "flat_type") continue;
      const values = flatTypeValues(condition);
      for (const value of values) {
        const normalized = normalizeHdbFlatType(String(value));
        if (!allowed.has(normalized)) errors.push(`Invalid HDB flat_type '${value}'.`);
      }
    }
  }
  return errors;
}

function flatTypeValues(condition: unknown): unknown[] {
  if (Array.isArray(condition)) return condition;
  if (typeof condition !== "object" || condition === null) return [condition];
  if ("op" in condition) {
    const value = (condition as { value?: unknown }).value;
    return Array.isArray(value) ? value : [value];
  }
  return [];
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
