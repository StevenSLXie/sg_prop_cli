import { AnalysisEngineError, analyzeRows, type AnalysisOutputMode, type AnalysisSegment } from "./analysis-engine.js";
import { baseMeta, fail, ok, sourceAttribution } from "./envelope.js";
import { rowMatchesFilters } from "./filters.js";
import { requireSource } from "./registry.js";
import type { HousingFilters, ResultEnvelope } from "./types.js";
import { UraClient } from "./ura-client.js";
import { flattenSaleRows, uraFailure } from "./ura-tools.js";
import { normalizeUraLookupKey, resolveUraSaleCandidatePlan } from "./ura-project-resolver.js";

export type AnalysisSegmentSpec = {
  name: string;
  filters?: HousingFilters;
  proxy_for?: string;
  unavailable_field?: string;
  proxy_field?: string;
  note?: string;
};

export type AnalyzePrivateResidentialSalesInput = {
  project?: string;
  projects?: string[];
  street?: string;
  streets?: string[];
  district?: string;
  districts?: string[];
  market_segment?: string;
  market_segments?: string[];
  property_type?: string;
  property_types?: string[];
  type_of_sale?: "new_sale" | "sub_sale" | "resale";
  type_of_sales?: Array<"new_sale" | "sub_sale" | "resale">;
  from?: string;
  to?: string;
  min_area_sqm?: number;
  max_area_sqm?: number;
  min_price?: number;
  max_price?: number;
  min_price_psf?: number;
  max_price_psf?: number;
  floor_range?: string;
  group_by?: string[];
  segments?: AnalysisSegmentSpec[];
  metrics?: string[];
  output?: AnalysisOutputMode;
  max_output_rows?: number;
  max_output_columns?: number;
};

export type AnalyzePrivateResidentialSalesData = {
  columns: string[];
  rows: Record<string, unknown>[];
  assumptions: Record<string, unknown>[];
  diagnostics: Record<string, unknown>;
};

const TOOL = "analyze_private_residential_sales";
const SOURCE_KEY = "ura_private_residential_transactions";

export async function analyzePrivateResidentialSales(
  input: AnalyzePrivateResidentialSalesInput,
  client = new UraClient()
): Promise<ResultEnvelope<AnalyzePrivateResidentialSalesData>> {
  const source = requireSource(SOURCE_KEY);
  const projects = uniqueStrings([input.project, ...(input.projects ?? [])]);
  const streets = uniqueStrings([input.street, ...(input.streets ?? [])]);
  const districts = uniqueStrings([input.district, ...(input.districts ?? [])]);
  const plan = resolveUraSaleCandidatePlan({ projects, streets, districts });

  try {
    const scannedRows: Record<string, unknown>[] = [];
    for (const batch of plan.batches) {
      const payload = await client.invoke("PMI_Resi_Transaction", { batch });
      scannedRows.push(...flattenSaleRows(payload, batch).map(deriveSaleAnalysisFields));
    }

    const rows = scannedRows.filter((row) => rowMatchesSaleAnalysisInput(row, input, projects, streets, districts));
    const segments = buildSegments(input.segments);
    const result = analyzeRows({
      rows,
      groupBy: input.group_by?.length ? input.group_by : ["project", "quarter"],
      segments,
      metrics: input.metrics?.length ? input.metrics : ["count", "price_median", "price_psf_median", "area_sqm_median"],
      output: input.output ?? "long_table",
      maxOutputRows: input.max_output_rows ?? 300,
      maxOutputColumns: input.max_output_columns ?? 60
    });

    return ok(
      TOOL,
      {
        ...result,
        assumptions: buildAssumptions(input.segments),
        diagnostics: {
          candidate_plan: plan,
          batches_requested: plan.batches,
          rows_scanned: scannedRows.length,
          matching_rows: rows.length,
          group_by: input.group_by?.length ? input.group_by : ["project", "quarter"],
          metrics: input.metrics?.length ? input.metrics : ["count", "price_median", "price_psf_median", "area_sqm_median"],
          output: input.output ?? "long_table"
        }
      },
      {
        ...baseMeta([SOURCE_KEY], [sourceAttribution(source)], source.caveats),
        rows_returned: result.rows.length,
        rows_scanned: scannedRows.length,
        batches_scanned: plan.batches.length,
        complete: true,
        truncated: false,
        next_cursor: null
      }
    );
  } catch (error) {
    if (error instanceof AnalysisEngineError) {
      return fail(TOOL, error.code, error.message, "Reduce groups, segments, or metrics, or raise output caps within documented limits.", {
        affected_sources: [SOURCE_KEY],
        details: { candidate_plan: plan }
      });
    }
    return uraFailure(TOOL, SOURCE_KEY, error);
  }
}

function deriveSaleAnalysisFields(row: Record<string, unknown>): Record<string, unknown> {
  const contractMonth = String(row.contract_month ?? "");
  const year = /^\d{4}-\d{2}$/.test(contractMonth) ? contractMonth.slice(0, 4) : null;
  const month = /^\d{4}-\d{2}$/.test(contractMonth) ? Number(contractMonth.slice(5, 7)) : null;
  const quarter = year && month ? `${year}-Q${Math.ceil(month / 3)}` : null;
  return {
    ...row,
    month: contractMonth || null,
    year,
    quarter
  };
}

function rowMatchesSaleAnalysisInput(
  row: Record<string, unknown>,
  input: AnalyzePrivateResidentialSalesInput,
  projects: string[],
  streets: string[],
  districts: string[]
): boolean {
  if (projects.length > 0 && !matchesAnyNormalized(row.project, projects)) return false;
  if (streets.length > 0 && !matchesAnyNormalized(row.street, streets)) return false;

  const filters: HousingFilters = {};
  if (districts.length === 1) filters.district = districts[0]!;
  else if (districts.length > 1) filters.district = districts;
  if (input.market_segment) filters.market_segment = input.market_segment;
  if (input.market_segments?.length) filters.market_segment = input.market_segments;
  if (input.property_type) filters.property_type = input.property_type;
  if (input.property_types?.length) filters.property_type = input.property_types;
  if (input.type_of_sale) filters.type_of_sale = input.type_of_sale;
  if (input.type_of_sales?.length) filters.type_of_sale = input.type_of_sales;
  if (input.from || input.to) filters.contract_month = range(normalizeMonthInput(input.from), normalizeMonthInput(input.to));
  if (input.min_area_sqm !== undefined || input.max_area_sqm !== undefined) filters.area_sqm = range(input.min_area_sqm, input.max_area_sqm);
  if (input.min_price !== undefined || input.max_price !== undefined) filters.price = range(input.min_price, input.max_price);
  if (input.min_price_psf !== undefined || input.max_price_psf !== undefined) filters.price_psf = range(input.min_price_psf, input.max_price_psf);
  if (input.floor_range) filters.floor_range = input.floor_range;
  return rowMatchesFilters(row, filters);
}

function buildSegments(specs: AnalysisSegmentSpec[] | undefined): AnalysisSegment<Record<string, unknown>>[] {
  if (!specs?.length) return [{ name: "all" }];
  return specs.map((segment) => ({
    name: segment.name,
    matches: segment.filters ? (row) => rowMatchesFilters(row, segment.filters) : undefined
  }));
}

function buildAssumptions(specs: AnalysisSegmentSpec[] | undefined): Record<string, unknown>[] {
  return (specs ?? [])
    .filter((segment) => segment.proxy_for || segment.unavailable_field)
    .map((segment) => {
      const unavailable = segment.unavailable_field ?? segment.proxy_for;
      const proxy = segment.proxy_field ?? inferProxyField(segment.filters);
      return {
        code: unavailable === "bedrooms" ? "BEDROOMS_UNAVAILABLE_AREA_PROXY" : "UNAVAILABLE_FIELD_PROXY",
        segment: segment.name,
        proxy_for: segment.proxy_for ?? unavailable,
        unavailable_field: unavailable,
        proxy_field: proxy,
        note: segment.note ?? `URA private residential sale transactions do not include ${unavailable}; this segment uses ${proxy} as a proxy.`
      };
    });
}

function inferProxyField(filters: HousingFilters | undefined): string | null {
  if (!filters) return null;
  if ("area_sqm" in filters || "area_sqm_gte" in filters || "area_sqm_lte" in filters) return "area_sqm";
  if ("price" in filters || "price_gte" in filters || "price_lte" in filters) return "price";
  if ("price_psf" in filters || "price_psf_gte" in filters || "price_psf_lte" in filters) return "price_psf";
  return null;
}

function matchesAnyNormalized(actual: unknown, expected: string[]): boolean {
  const actualKey = normalizeUraLookupKey(String(actual ?? ""));
  return expected.some((value) => {
    const expectedKey = normalizeUraLookupKey(value);
    return actualKey === expectedKey || actualKey.includes(expectedKey) || expectedKey.includes(actualKey);
  });
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function range(gte?: string | number, lte?: string | number): { gte?: string | number; lte?: string | number } {
  return { gte, lte };
}

function normalizeMonthInput(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(value);
  return match ? match[1] : value;
}
