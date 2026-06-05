import { DataGovClient, DataGovError } from "./datagov-client.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { baseMeta, fail, ok, sourceAttribution } from "./envelope.js";
import { normalizeFilters, rowMatchesFilters, validateFilters } from "./filters.js";
import { compactFields, requireSource } from "./registry.js";
import type { HousingFilters, ResultEnvelope, SourceKey } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_MAX_PAGES = 5;
const MAX_MAX_PAGES = 50;
const DEFAULT_MAX_ROWS_SCANNED = 5000;
const MAX_ROWS_SCANNED = 20000;
const PAGE_SIZE = 500;

export type QueryHousingRowsInput = {
  source: SourceKey;
  filters?: HousingFilters;
  select?: string[];
  limit?: number;
  cursor?: string;
  max_pages?: number;
  max_rows_scanned?: number;
  include_raw?: boolean;
};

type RowCursorPayload = {
  kind: "row";
  source: SourceKey;
  filters?: HousingFilters;
  select?: string[];
  include_raw?: boolean;
  dataset_index: number;
  offset: number;
  rows_scanned: number;
  pages_scanned: number;
};

export async function queryHousingRows(
  input: QueryHousingRowsInput,
  client = new DataGovClient()
): Promise<ResultEnvelope<{ rows: Record<string, unknown>[] }>> {
  const tool = "query_housing_rows";
  let sourceKey = input.source;
  let filters = input.filters;
  let select = input.select;
  let includeRaw = Boolean(input.include_raw);
  let datasetIndex = 0;
  let offset = 0;
  let previousRowsScanned = 0;
  let previousPagesScanned = 0;

  if (input.cursor) {
    try {
      const cursor = decodeCursor<RowCursorPayload>(input.cursor);
      if (cursor.kind !== "row") throw new Error("Wrong cursor type.");
      if (!Number.isInteger(cursor.dataset_index) || cursor.dataset_index < 0) throw new Error("Invalid dataset index.");
      if (!Number.isInteger(cursor.offset) || cursor.offset < 0) throw new Error("Invalid offset.");
      if (!Number.isInteger(cursor.rows_scanned) || cursor.rows_scanned < 0) throw new Error("Invalid rows scanned.");
      if (!Number.isInteger(cursor.pages_scanned) || cursor.pages_scanned < 0) throw new Error("Invalid pages scanned.");
      sourceKey = cursor.source;
      filters = cursor.filters;
      select = cursor.select;
      includeRaw = Boolean(cursor.include_raw);
      datasetIndex = cursor.dataset_index;
      offset = cursor.offset;
      previousRowsScanned = cursor.rows_scanned;
      previousPagesScanned = cursor.pages_scanned;
    } catch (error) {
      return fail(tool, "VALIDATION_ERROR", "Invalid cursor.", "Use a cursor returned by this tool.", {
        details: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  const source = requireSource(sourceKey);
  if (source.backend !== "data_gov_sg") {
    return fail(
      tool,
      "SOURCE_UNAVAILABLE",
      `${source.source_key} is not available through data.gov.sg row query yet.`,
      "Use a data.gov.sg-backed source or a dedicated URA tool.",
      { affected_sources: [source.source_key] }
    );
  }

  const limit = clamp(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxPages = clamp(input.max_pages ?? DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
  const maxRowsScanned = clamp(input.max_rows_scanned ?? DEFAULT_MAX_ROWS_SCANNED, 1, MAX_ROWS_SCANNED);
  if (includeRaw && limit > 50) {
    return fail(tool, "VALIDATION_ERROR", "include_raw requires limit <= 50.", "Lower limit or omit include_raw.", {
      affected_sources: [source.source_key]
    });
  }

  const validationErrors = validateFilters(source.fields, filters);
  const selectedFields = select && select.length > 0 ? select : compactFields(source);
  const allowedFields = new Set(source.fields.map((field) => field.name));
  const invalidSelect = selectedFields.filter((field) => !allowedFields.has(field));
  if (validationErrors.length > 0 || invalidSelect.length > 0) {
    return fail(tool, "VALIDATION_ERROR", "Invalid filters or selected fields.", "Call list_housing_sources with a narrow source_keys filter to inspect fields.", {
      affected_sources: [source.source_key],
      details: {
        filter_errors: validationErrors,
        invalid_select: invalidSelect,
        allowed_fields: [...allowedFields]
      }
    });
  }

  const datasetIds = source.dataset_ids ?? [];
  if (datasetIds.length === 0) {
    return fail(tool, "SOURCE_UNAVAILABLE", `${source.source_key} has no dataset id configured.`, "Use another source.", {
      affected_sources: [source.source_key]
    });
  }
  if (datasetIndex >= datasetIds.length) {
    return fail(tool, "VALIDATION_ERROR", "Invalid cursor dataset index.", "Use a cursor returned by this tool for the same source.", {
      affected_sources: [source.source_key]
    });
  }

  const rows: Record<string, unknown>[] = [];
  let pagesScanned = previousPagesScanned;
  let rowsScanned = previousRowsScanned;
  let backendTotal: number | null = null;
  let nextCursor: string | null = null;
  let complete = true;

  try {
    outer: for (let i = datasetIndex; i < datasetIds.length; i++) {
      let currentOffset = i === datasetIndex ? offset : 0;
      for (;;) {
        if (pagesScanned - previousPagesScanned >= maxPages || rowsScanned - previousRowsScanned >= maxRowsScanned) {
          complete = false;
          nextCursor = encodeCursor({
            kind: "row",
            source: source.source_key,
            filters,
            select: selectedFields,
            include_raw: includeRaw,
            dataset_index: i,
            offset: currentOffset,
            rows_scanned: rowsScanned,
            pages_scanned: pagesScanned
          });
          break outer;
        }

        const remainingScanRows = maxRowsScanned - (rowsScanned - previousRowsScanned);
        const response = await client.searchRows({
          resourceId: datasetIds[i]!,
          limit: Math.min(PAGE_SIZE, remainingScanRows),
          offset: currentOffset,
          filters: exactServerFilters(filters)
        });
        pagesScanned += 1;
        backendTotal = response.total;
        rowsScanned += response.records.length;

        for (let rawIndex = 0; rawIndex < response.records.length; rawIndex++) {
          const rawRow = response.records[rawIndex]!;
          const normalized = normalizeRow(rawRow, source.fields);
          if (!rowMatchesFilters(normalized, filters)) continue;
          rows.push(projectRow(normalized, rawRow, selectedFields, includeRaw));
          if (rows.length >= limit) {
            const nextOffset = currentOffset + rawIndex + 1;
            const hasMoreInDataset = response.total === null || nextOffset < response.total;
            if (hasMoreInDataset || i + 1 < datasetIds.length) {
              nextCursor = encodeCursor({
                kind: "row",
                source: source.source_key,
                filters,
                select: selectedFields,
                include_raw: includeRaw,
                dataset_index: hasMoreInDataset ? i : i + 1,
                offset: hasMoreInDataset ? nextOffset : 0,
                rows_scanned: rowsScanned,
                pages_scanned: pagesScanned
              });
            }
            break outer;
          }
        }

        currentOffset += response.records.length;
        if (response.records.length === 0 || (response.total !== null && currentOffset >= response.total)) {
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof DataGovError) {
      return fail(tool, error.code, error.message, "Retry later or narrow the query.", {
        recoverable: true,
        affected_sources: [source.source_key]
      });
    }
    throw error;
  }

  return ok(
    tool,
    { rows },
    {
      ...baseMeta([source.source_key], [sourceAttribution(source, datasetIds[datasetIndex])], source.caveats),
      rows_returned: rows.length,
      rows_scanned: rowsScanned,
      pages_scanned: pagesScanned,
      backend_total: backendTotal,
      complete: complete && nextCursor === null,
      truncated: !complete,
      next_cursor: nextCursor
    }
  );
}

export function normalizeRow(row: Record<string, unknown>, fields: { name: string; type: string }[]): Record<string, unknown> {
  const numericFields = new Set(fields.filter((field) => field.type === "number").map((field) => field.name));
  const normalized: Record<string, unknown> = { ...row };
  for (const field of numericFields) {
    if (normalized[field] === undefined || normalized[field] === null) continue;
    const value = Number(String(normalized[field]).replace(/,/g, ""));
    normalized[field] = Number.isNaN(value) ? null : value;
  }
  return normalized;
}

function projectRow(
  row: Record<string, unknown>,
  rawRow: Record<string, unknown>,
  selectedFields: string[],
  includeRaw: boolean
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of selectedFields) {
    projected[field] = row[field] ?? null;
  }
  if (includeRaw) projected.raw = rawRow;
  return projected;
}

function exactServerFilters(filters: HousingFilters | undefined): Record<string, string | number | Array<string | number>> | undefined {
  const serverFilters: Record<string, string | number | Array<string | number>> = {};
  for (const filter of normalizeFilters(filters)) {
    if (filter.op !== "eq" && filter.op !== "in") continue;
    if (typeof filter.value === "boolean") continue;
    if (Array.isArray(filter.value)) {
      const values = filter.value.filter((value): value is string | number => typeof value !== "boolean");
      if (values.length > 0) serverFilters[filter.field] = values;
    } else {
      serverFilters[filter.field] = filter.value;
    }
  }
  return Object.keys(serverFilters).length > 0 ? serverFilters : undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
