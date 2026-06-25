import { baseMeta, fail, ok, sourceAttribution } from "./envelope.js";
import { resolveFilterAliases, rowMatchesFilters, validateFilters } from "./filters.js";
import { compactFields, requireSource, resolveFieldNames } from "./registry.js";
import { countBy, numericSummary, summaryMeta } from "./summary.js";
import type { HousingFilters, ResultEnvelope, SourceKey, SummaryMeta } from "./types.js";
import { UraClient, UraError } from "./ura-client.js";

const SQM_TO_SQFT = 10.7639104167;

export type PrivateRowsInput = {
  project?: string;
  street?: string;
  district?: string;
  market_segment?: string;
  property_type?: string;
  type_of_sale?: "new_sale" | "sub_sale" | "resale";
  from?: string;
  to?: string;
  min_area_sqm?: number;
  max_area_sqm?: number;
  min_price?: number;
  max_price?: number;
  min_price_psf?: number;
  max_price_psf?: number;
  floor_range?: string;
  bedrooms?: number;
  min_rent?: number;
  max_rent?: number;
  limit?: number;
  select?: string[];
  include_raw?: boolean;
  output_mode?: "rows" | "summary" | "both";
  max_batches?: number;
};

export async function findPrivateResidentialSaleComparables(
  input: PrivateRowsInput,
  client = new UraClient()
): Promise<ResultEnvelope<{ rows?: Record<string, unknown>[]; summary?: Record<string, unknown> }>> {
  const source = requireSource("ura_private_residential_transactions");
  const limit = boundedLimit(input.limit ?? 30, 300);
  if (input.include_raw && limit > 50) return rawLimitError("find_private_residential_sale_comparables", source.source_key);
  const select = input.select?.length ? resolveFieldNames(source.fields, input.select) : compactFields(source);
  const selectError = validateSelect(source.source_key, select);
  if (selectError) return selectError("find_private_residential_sale_comparables");
  const filters = resolveFilterAliases(source.fields, saleFilters(input));
  const validation = validateFilters(source.fields, filters);
  if (validation.length) {
    return fail("find_private_residential_sale_comparables", "VALIDATION_ERROR", "Invalid private sale filters.", "Inspect source fields and retry.", {
      affected_sources: [source.source_key],
      details: { filter_errors: validation }
    });
  }

  try {
    const rows: Record<string, unknown>[] = [];
    let rowsScanned = 0;
    const batches = candidateBatches(input.district).slice(0, input.max_batches ?? 4);
    for (const batch of batches) {
      const payload = await client.invoke("PMI_Resi_Transaction", { batch });
      for (const row of flattenSaleRows(payload, batch)) {
        rowsScanned += 1;
        if (!rowMatchesFilters(row, filters)) continue;
        rows.push(row);
      }
    }
    return privateRowsOk(
      "find_private_residential_sale_comparables",
      source.source_key,
      rows,
      rowsScanned,
      limit,
      input.output_mode,
      select,
      Boolean(input.include_raw),
      {
        price: numericSummary(rows.map((row) => Number(row.price)).filter(Number.isFinite)),
        price_psf: numericSummary(rows.map((row) => Number(row.price_psf)).filter(Number.isFinite)),
        area_sqm: numericSummary(rows.map((row) => Number(row.area_sqm)).filter(Number.isFinite)),
        by_type_of_sale: countBy(rows, "type_of_sale"),
        by_property_type: countBy(rows, "property_type"),
        by_district: countBy(rows, "district"),
        project_summaries: groupedNumericSummaries(rows, "project", ["street", "district", "market_segment"], 12)
      },
      batches.length
    );
  } catch (error) {
    return uraFailure("find_private_residential_sale_comparables", source.source_key, error);
  }
}

export async function findPrivateResidentialRentalContracts(
  input: PrivateRowsInput,
  client = new UraClient()
): Promise<ResultEnvelope<{ rows?: Record<string, unknown>[]; summary?: Record<string, unknown> }>> {
  const source = requireSource("ura_private_residential_rentals");
  const limit = boundedLimit(input.limit ?? 30, 300);
  if (input.include_raw && limit > 50) return rawLimitError("find_private_residential_rental_contracts", source.source_key);
  const select = input.select?.length ? resolveFieldNames(source.fields, input.select) : compactFields(source);
  const selectError = validateSelect(source.source_key, select);
  if (selectError) return selectError("find_private_residential_rental_contracts");
  const filters = resolveFilterAliases(source.fields, rentalFilters(input));
  const validation = validateFilters(source.fields, filters);
  if (validation.length) {
    return fail("find_private_residential_rental_contracts", "VALIDATION_ERROR", "Invalid private rental filters.", "Inspect source fields and retry.", {
      affected_sources: [source.source_key],
      details: { filter_errors: validation }
    });
  }

  try {
    const rows: Record<string, unknown>[] = [];
    let rowsScanned = 0;
    for (const refPeriod of rentalPeriods(input.from, input.to)) {
      const payload = await client.invoke("PMI_Resi_Rental", { refPeriod: toUraQuarter(refPeriod) });
      for (const row of flattenRentalRows(payload, refPeriod)) {
        rowsScanned += 1;
        if (!rowMatchesFilters(row, filters)) continue;
        rows.push(row);
      }
    }
    return privateRowsOk("find_private_residential_rental_contracts", source.source_key, rows, rowsScanned, limit, input.output_mode, select, Boolean(input.include_raw), {
      rent: numericSummary(rows.map((row) => Number(row.rent)).filter(Number.isFinite)),
      rent_psf: numericSummary(rows.map((row) => Number(row.rent_psf)).filter(Number.isFinite))
    });
  } catch (error) {
    return uraFailure("find_private_residential_rental_contracts", source.source_key, error);
  }
}

export async function getPrivateResidentialRentalMedians(input: PrivateRowsInput, client = new UraClient()) {
  return simpleUraRows("get_private_residential_rental_medians", "ura_private_rental_medians", "PMI_Resi_Rental_Median", input, client, flattenMedianRows);
}

export async function getPrivateDeveloperSales(input: PrivateRowsInput, client = new UraClient()) {
  return simpleUraRows("get_private_developer_sales", "ura_private_developer_sales", "PMI_Resi_Developer_Sales", input, client, flattenDeveloperRows);
}

function privateRowsOk(
  tool: string,
  sourceKey: SourceKey,
  allRows: Record<string, unknown>[],
  rowsScanned: number,
  limit: number,
  outputMode: "rows" | "summary" | "both" = "both",
  select: string[],
  includeRaw: boolean,
  summary: Record<string, unknown>,
  batchesScanned?: number
): ResultEnvelope<{ rows?: Record<string, unknown>[]; summary?: Record<string, unknown> }> {
  const source = requireSource(sourceKey);
  const rows = allRows.slice(0, limit).map((row) => project(row, select, includeRaw));
  const rowTruncated = allRows.length > limit;
  const meta: SummaryMeta = summaryMeta(allRows.length, rowsScanned, true, false);
  const data: { rows?: Record<string, unknown>[]; summary?: Record<string, unknown> } = {};
  if (outputMode !== "summary") data.rows = rows;
  if (outputMode !== "rows") data.summary = { meta, sample_size: allRows.length, ...summary };
  return ok(tool, data, {
    ...baseMeta([sourceKey], [sourceAttribution(source)], source.caveats),
    rows_returned: rows.length,
    rows_scanned: rowsScanned,
    batches_scanned: batchesScanned,
    complete: !rowTruncated,
    truncated: rowTruncated,
    next_cursor: null
  });
}

async function simpleUraRows(
  tool: string,
  sourceKey: SourceKey,
  service: string,
  input: PrivateRowsInput,
  client: UraClient,
  flattener: (payload: unknown) => Record<string, unknown>[]
) {
  const source = requireSource(sourceKey);
  const limit = boundedLimit(input.limit ?? 50, 500);
  if (input.include_raw && limit > 50) return rawLimitError(tool, sourceKey);
  const select = input.select?.length ? resolveFieldNames(source.fields, input.select) : compactFields(source);
  const selectError = validateSelect(sourceKey, select);
  if (selectError) return selectError(tool);
  try {
    const payload = await client.invoke(service, {});
    const filters = resolveFilterAliases(source.fields, genericFilters(input));
    const scannedRows = flattener(payload);
    const rows = scannedRows.filter((row) => rowMatchesFilters(row, filters));
    const projected = rows.slice(0, limit).map((row) => project(row, select, Boolean(input.include_raw)));
    const rowTruncated = rows.length > limit;
    return ok(
      tool,
      { rows: projected },
      {
        ...baseMeta([sourceKey], [sourceAttribution(source)], source.caveats),
        rows_returned: projected.length,
        rows_scanned: scannedRows.length,
        complete: !rowTruncated,
        truncated: rowTruncated,
        next_cursor: null
      }
    );
  } catch (error) {
    return uraFailure(tool, sourceKey, error);
  }
}

function groupedNumericSummaries(
  rows: Record<string, unknown>[],
  groupField: string,
  carryFields: string[],
  limit: number
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row[groupField] ?? "unknown");
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => {
      const first = groupRows[0] ?? {};
      return {
        [groupField]: key,
        ...Object.fromEntries(carryFields.map((field) => [field, first[field] ?? null])),
        count: groupRows.length,
        ...flattenSummary("price", numericSummary(groupRows.map((row) => Number(row.price)).filter(Number.isFinite))),
        ...flattenSummary("price_psf", numericSummary(groupRows.map((row) => Number(row.price_psf)).filter(Number.isFinite))),
        ...flattenSummary("area_sqm", numericSummary(groupRows.map((row) => Number(row.area_sqm)).filter(Number.isFinite)))
      };
    })
    .sort((a, b) => Number(b.count ?? 0) - Number(a.count ?? 0))
    .slice(0, limit);
}

function flattenSummary(prefix: string, summary: ReturnType<typeof numericSummary>): Record<string, number | null> {
  return {
    [`${prefix}_min`]: summary.min,
    [`${prefix}_max`]: summary.max,
    [`${prefix}_avg`]: summary.avg,
    [`${prefix}_median`]: summary.median
  };
}

export function flattenSaleRows(payload: unknown, batch: number): Record<string, unknown>[] {
  return resultArray(payload).flatMap((project) => {
    const projectRecord = project as Record<string, unknown>;
    return arrayAt(projectRecord, "transaction").map((transaction) => {
      const tx = transaction as Record<string, unknown>;
      const area = numberAt(tx, "area");
      const price = numberAt(tx, "price");
      const row = {
        project: stringAt(projectRecord, "project"),
        street: stringAt(projectRecord, "street"),
        market_segment: stringAt(projectRecord, "marketSegment"),
        district: stringAt(tx, "district"),
        contract_month: normalizeContractMonth(stringAt(tx, "contractDate")),
        contract_date_raw: stringAt(tx, "contractDate"),
        type_of_sale: saleType(stringAt(tx, "typeOfSale")),
        type_of_sale_code: stringAt(tx, "typeOfSale"),
        property_type: stringAt(tx, "propertyType"),
        tenure: stringAt(tx, "tenure"),
        type_of_area: stringAt(tx, "typeOfArea"),
        floor_range: stringAt(tx, "floorRange"),
        area_sqm: area,
        price,
        nett_price: numberAt(tx, "nettPrice"),
        price_psm: area && price ? price / area : null,
        price_psf: area && price ? price / (area * SQM_TO_SQFT) : null,
        no_of_units: numberAt(tx, "noOfUnits"),
        x: numberAt(projectRecord, "x"),
        y: numberAt(projectRecord, "y"),
        batch,
        raw: { project: projectRecord, transaction: tx }
      };
      return row;
    });
  });
}

function flattenRentalRows(payload: unknown, fallbackRefPeriod: string): Record<string, unknown>[] {
  return resultArray(payload).flatMap((project) => {
    const projectRecord = project as Record<string, unknown>;
    const rentals = arrayAt(projectRecord, "rental").concat(arrayAt(projectRecord, "rentals"));
    return rentals.map((rental) => {
      const rent = rental as Record<string, unknown>;
      const area = numberAt(rent, "area");
      const monthlyRent = numberAt(rent, "rent") ?? numberAt(rent, "monthlyRent");
      return {
        project: stringAt(projectRecord, "project"),
        street: stringAt(projectRecord, "street"),
        district: stringAt(rent, "district") || stringAt(projectRecord, "district"),
        ref_period: normalizeQuarter(stringAt(rent, "refPeriod")) || fallbackRefPeriod,
        property_type: stringAt(rent, "propertyType"),
        bedrooms: numberAt(rent, "bedrooms") ?? numberAt(rent, "noOfBedRoom"),
        area_sqm: area,
        rent: monthlyRent,
        rent_psf: area && monthlyRent ? monthlyRent / (area * SQM_TO_SQFT) : null,
        raw: { project: projectRecord, rental: rent }
      };
    });
  });
}

function flattenMedianRows(payload: unknown): Record<string, unknown>[] {
  return resultArray(payload).map((record) => {
    const row = record as Record<string, unknown>;
    return {
      project: stringAt(row, "project"),
      street: stringAt(row, "street"),
      district: stringAt(row, "district"),
      ref_period: normalizeQuarter(stringAt(row, "refPeriod")),
      psf25: numberAt(row, "psf25") ?? numberAt(row, "25th"),
      median: numberAt(row, "median"),
      psf75: numberAt(row, "psf75") ?? numberAt(row, "75th"),
      x: numberAt(row, "x"),
      y: numberAt(row, "y"),
      raw: row
    };
  });
}

function flattenDeveloperRows(payload: unknown): Record<string, unknown>[] {
  return resultArray(payload).flatMap((project) => {
    const projectRecord = project as Record<string, unknown>;
    return arrayAt(projectRecord, "developerSales").map((sale) => {
      const row = sale as Record<string, unknown>;
      return {
        project: stringAt(projectRecord, "project"),
        street: stringAt(projectRecord, "street"),
        developer: stringAt(projectRecord, "developer"),
        district: stringAt(projectRecord, "district"),
        market_segment: stringAt(projectRecord, "marketSegment"),
        ref_period: normalizeMonthFromMmyy(stringAt(row, "refPeriod")),
        lowest_price_psf: numberAt(row, "lowestPrice"),
        median_price_psf: numberAt(row, "medianPrice"),
        highest_price_psf: numberAt(row, "highestPrice"),
        units_available: numberAt(row, "unitsAvail"),
        launched_to_date: numberAt(row, "launchedToDate"),
        sold_to_date: numberAt(row, "soldToDate"),
        launched_in_month: numberAt(row, "launchedInMonth"),
        sold_in_month: numberAt(row, "soldInMonth"),
        raw: { project: projectRecord, sale: row }
      };
    });
  });
}

function saleFilters(input: PrivateRowsInput): HousingFilters {
  return cleanFilters({
    project: input.project ? { op: "contains", value: input.project } : undefined,
    street: input.street ? { op: "contains", value: input.street } : undefined,
    district: input.district,
    market_segment: input.market_segment,
    property_type: input.property_type,
    type_of_sale: input.type_of_sale,
    contract_month: range(normalizeMonthInput(input.from), normalizeMonthInput(input.to)),
    area_sqm: range(input.min_area_sqm, input.max_area_sqm),
    price: range(input.min_price, input.max_price),
    price_psf: range(input.min_price_psf, input.max_price_psf),
    floor_range: input.floor_range
  });
}

function rentalFilters(input: PrivateRowsInput): HousingFilters {
  return cleanFilters({
    project: input.project ? { op: "contains", value: input.project } : undefined,
    street: input.street ? { op: "contains", value: input.street } : undefined,
    district: input.district,
    property_type: input.property_type,
    bedrooms: input.bedrooms,
    ref_period: range(input.from, input.to),
    area_sqm: range(input.min_area_sqm, input.max_area_sqm),
    rent: range(input.min_rent, input.max_rent)
  });
}

function genericFilters(input: PrivateRowsInput): HousingFilters {
  return cleanFilters({
    project: input.project ? { op: "contains", value: input.project } : undefined,
    district: input.district,
    market_segment: input.market_segment,
    ref_period: range(input.from, input.to)
  });
}

function cleanFilters(filters: Record<string, unknown>): HousingFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as HousingFilters;
}

function range(gte?: string | number, lte?: string | number): { gte?: string | number; lte?: string | number } | undefined {
  if (gte === undefined && lte === undefined) return undefined;
  return { gte, lte };
}

function project(row: Record<string, unknown>, select: string[], includeRaw: boolean): Record<string, unknown> {
  const projected: Record<string, unknown> = Object.fromEntries(select.map((field) => [field, row[field] ?? null]));
  if (includeRaw) projected.raw = row.raw;
  return projected;
}

function resultArray(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const result = (payload as Record<string, unknown>).Result;
  return Array.isArray(result) ? result : [];
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? "" : String(value);
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function saleType(code: string): string {
  if (code === "1") return "new_sale";
  if (code === "2") return "sub_sale";
  if (code === "3") return "resale";
  return code;
}

function normalizeContractMonth(mmyy: string): string {
  if (!/^\d{4}$/.test(mmyy)) return mmyy;
  return normalizeMonthFromMmyy(mmyy);
}

function normalizeMonthFromMmyy(mmyy: string): string {
  if (!/^\d{4}$/.test(mmyy)) return mmyy;
  const month = mmyy.slice(0, 2);
  const yy = Number(mmyy.slice(2));
  const currentYear = new Date().getFullYear();
  const century = 2000 + yy > currentYear + 1 ? 1900 : 2000;
  return `${century + yy}-${month}`;
}

function normalizeMonthInput(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(value);
  return match ? match[1] : value;
}

function normalizeQuarter(value: string): string {
  const match = /^(\d{2})q([1-4])$/i.exec(value);
  if (!match) return value;
  return `20${match[1]}-Q${match[2]}`;
}

function toUraQuarter(value: string): string {
  const match = /^(\d{4})-Q([1-4])$/i.exec(value);
  if (!match) return value;
  return `${match[1].slice(2)}q${match[2]}`;
}

function rentalPeriods(from?: string, to?: string): string[] {
  if (from && to && from === to) return [from];
  if (from && !to) return [from];
  if (!from && to) return [to];
  if (from && to) return quarterRange(from, to);
  return [latestQuarter()];
}

function quarterRange(from: string, to: string): string[] {
  const start = parseQuarter(from);
  const end = parseQuarter(to);
  if (!start || !end) return [from, to];
  const result: string[] = [];
  if (end < start) {
    throw new UraError("URA_SERVICE_UNAVAILABLE", "Invalid rental quarter range: to must be after from.");
  }
  if (end - start + 1 > 20) {
    throw new UraError("URA_SERVICE_UNAVAILABLE", "Rental quarter range exceeds 20 quarters.");
  }
  for (let index = start; index <= end; index++) {
    const year = Math.floor(index / 4);
    const quarter = (index % 4) + 1;
    result.push(`${year}-Q${quarter}`);
  }
  return result;
}

function parseQuarter(value: string): number | null {
  const match = /^(\d{4})-Q([1-4])$/i.exec(value);
  if (!match) return null;
  return Number(match[1]) * 4 + Number(match[2]) - 1;
}

function latestQuarter(): string {
  const now = new Date();
  const month = now.getUTCMonth();
  const quarter = Math.max(1, Math.ceil(month / 3));
  return `${now.getUTCFullYear()}-Q${quarter}`;
}

function candidateBatches(district?: string): number[] {
  const number = district ? Number(district) : NaN;
  if (!Number.isFinite(number)) return [1, 2, 3, 4];
  if (number <= 7) return [1];
  if (number <= 14) return [2];
  if (number <= 21) return [3];
  return [4];
}

function boundedLimit(limit: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

function rawLimitError(tool: string, sourceKey: SourceKey) {
  return fail(tool, "VALIDATION_ERROR", "include_raw requires limit <= 50.", "Lower limit or omit include_raw.", {
    affected_sources: [sourceKey]
  });
}

function validateSelect(sourceKey: SourceKey, select: string[]) {
  const source = requireSource(sourceKey);
  const allowed = new Set(source.fields.map((field) => field.name));
  const invalid = select.filter((field) => field === "raw" || !allowed.has(field));
  if (invalid.length === 0) return null;
  return (tool: string) =>
    fail(tool, "VALIDATION_ERROR", "Invalid selected fields.", "Use list_housing_sources to inspect selectable compact fields; raw is controlled only by include_raw.", {
      affected_sources: [sourceKey],
      details: { invalid_select: invalid, allowed_fields: [...allowed] }
    });
}

export function uraFailure(tool: string, sourceKey: SourceKey, error: unknown) {
  if (error instanceof UraError) {
    const nextAction =
      error.code === "URA_REQUIRES_MAINTAINED_DISTRIBUTION"
        ? "Use the maintained package/proxy or configure an approved URA credential strategy."
        : error.code === "URA_AUTH_FAILED"
          ? "Retry later; if this persists, the maintainer should rotate or verify the URA proxy credential."
          : "Retry later or narrow the query; if this persists, the maintainer should inspect the URA proxy and upstream URA Data Service.";
    return fail(tool, error.code, error.message, nextAction, {
      recoverable: error.code === "URA_RATE_LIMITED" || error.code === "URA_SERVICE_UNAVAILABLE",
      affected_sources: [sourceKey]
    });
  }
  return fail(tool, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error), "Retry or report the issue.", {
    affected_sources: [sourceKey]
  });
}
