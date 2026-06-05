import { DataGovClient, DataGovError } from "./datagov-client.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { baseMeta, fail, ok, sourceAttribution } from "./envelope.js";
import { resolveFilterAliases, rowMatchesFilters, validateFilters } from "./filters.js";
import { requireSource } from "./registry.js";
import { normalizeRow } from "./query.js";
import type { HousingFilters, ResultEnvelope, SourceKey } from "./types.js";

const PAGE_SIZE = 500;
const DEFAULT_SCAN = 5000;
const MAX_SCAN = 20000;
const MAX_CURSOR_CHARS = 6000;
const OPERATIONS = new Set(["count", "group_count", "top_n_by_count", "numeric_summary"]);

export type AggregateHousingRowsInput = {
  source: SourceKey;
  filters?: HousingFilters;
  operation: "count" | "group_count" | "top_n_by_count" | "numeric_summary";
  group_by?: string[];
  value_field?: string;
  top_n?: number;
  limit_rows_scanned?: number;
  cursor?: string;
  allow_partial?: boolean;
};

type AggregateState = {
  count: number;
  groups: Record<string, { key: Record<string, unknown>; count: number }>;
  values: number[];
};

type AggregateCursorPayload = {
  kind: "aggregate";
  source: SourceKey;
  filters?: HousingFilters;
  operation: AggregateHousingRowsInput["operation"];
  group_by?: string[];
  value_field?: string;
  dataset_index: number;
  offset: number;
  rows_scanned: number;
  pages_scanned: number;
  state: AggregateState;
};

export async function aggregateHousingRows(
  input: AggregateHousingRowsInput,
  client = new DataGovClient()
): Promise<ResultEnvelope<{ operation: string; result: unknown }>> {
  const tool = "aggregate_housing_rows";
  let sourceKey = input.source;
  let filters = input.filters;
  let operation = input.operation;
  let groupBy = input.group_by ?? [];
  let valueField = input.value_field;
  let datasetIndex = 0;
  let offset = 0;
  let rowsScanned = 0;
  let pagesScanned = 0;
  let state: AggregateState = { count: 0, groups: {}, values: [] };

  if (input.cursor) {
    try {
      const cursor = decodeCursor<AggregateCursorPayload>(input.cursor);
      if (cursor.kind !== "aggregate") throw new Error("Wrong cursor type.");
      if (!Number.isInteger(cursor.dataset_index) || cursor.dataset_index < 0) throw new Error("Invalid dataset index.");
      if (!Number.isInteger(cursor.offset) || cursor.offset < 0) throw new Error("Invalid offset.");
      if (!Number.isInteger(cursor.rows_scanned) || cursor.rows_scanned < 0) throw new Error("Invalid rows scanned.");
      if (!Number.isInteger(cursor.pages_scanned) || cursor.pages_scanned < 0) throw new Error("Invalid pages scanned.");
      if (!cursor.state || typeof cursor.state !== "object") throw new Error("Invalid aggregate state.");
      sourceKey = cursor.source;
      filters = cursor.filters;
      operation = cursor.operation;
      groupBy = cursor.group_by ?? [];
      valueField = cursor.value_field;
      datasetIndex = cursor.dataset_index;
      offset = cursor.offset;
      rowsScanned = cursor.rows_scanned;
      pagesScanned = cursor.pages_scanned;
      state = cursor.state;
    } catch (error) {
      return fail(tool, "VALIDATION_ERROR", "Invalid cursor.", "Use a cursor returned by this tool.", {
        details: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  const source = requireSource(sourceKey);
  filters = resolveFilterAliases(source.fields, filters);
  if (!OPERATIONS.has(operation)) {
    return fail(tool, "VALIDATION_ERROR", `Invalid operation '${operation}'.`, "Use count, group_count, top_n_by_count, or numeric_summary.", {
      affected_sources: [source.source_key],
      details: { allowed_operations: [...OPERATIONS] }
    });
  }
  if (source.backend !== "data_gov_sg") {
    return fail(tool, "SOURCE_UNAVAILABLE", `${source.source_key} is not aggregatable through data.gov.sg yet.`, "Use a data.gov.sg-backed source.", {
      affected_sources: [source.source_key]
    });
  }
  const validationErrors = validateFilters(source.fields, filters);
  const allowedFields = new Set(source.fields.map((field) => field.name));
  const invalidGroup = groupBy.filter((field) => !allowedFields.has(field));
  if (valueField && !allowedFields.has(valueField)) invalidGroup.push(valueField);
  if (validationErrors.length > 0 || invalidGroup.length > 0) {
    return fail(tool, "VALIDATION_ERROR", "Invalid aggregate fields.", "Call list_housing_sources with source_keys to inspect fields.", {
      affected_sources: [source.source_key],
      details: { filter_errors: validationErrors, invalid_fields: invalidGroup, allowed_fields: [...allowedFields] }
    });
  }
  if ((operation === "group_count" || operation === "top_n_by_count") && groupBy.length === 0) {
    return fail(tool, "VALIDATION_ERROR", "group_by is required for grouped aggregations.", "Set group_by to one or more fields.", {
      affected_sources: [source.source_key]
    });
  }
  if (operation === "numeric_summary" && !valueField) {
    return fail(tool, "VALIDATION_ERROR", "value_field is required for numeric_summary.", "Set value_field to a numeric field.", {
      affected_sources: [source.source_key]
    });
  }

  const datasetIds = source.dataset_ids ?? [];
  if (datasetIndex >= datasetIds.length) {
    return fail(tool, "VALIDATION_ERROR", "Invalid cursor dataset index.", "Use a cursor returned by this tool for the same source.", {
      affected_sources: [source.source_key]
    });
  }
  const scanLimit = clamp(input.limit_rows_scanned ?? DEFAULT_SCAN, 1, MAX_SCAN);
  const topN = clamp(input.top_n ?? 10, 1, 50);
  const scanStartRows = rowsScanned;
  let nextCursor: string | null = null;
  let complete = true;
  let backendTotal: number | null = null;

  try {
    outer: for (let i = datasetIndex; i < datasetIds.length; i++) {
      let currentOffset = i === datasetIndex ? offset : 0;
      for (;;) {
        if (rowsScanned - scanStartRows >= scanLimit) {
          complete = false;
          nextCursor = boundedCursor({
            kind: "aggregate",
            source: source.source_key,
            filters,
            operation,
            group_by: groupBy,
            value_field: valueField,
            dataset_index: i,
            offset: currentOffset,
            rows_scanned: rowsScanned,
            pages_scanned: pagesScanned,
            state
          });
          break outer;
        }
        const remainingScanRows = scanLimit - (rowsScanned - scanStartRows);
        const response = await client.searchRows({
          resourceId: datasetIds[i]!,
          limit: Math.min(PAGE_SIZE, remainingScanRows),
          offset: currentOffset
        });
        pagesScanned += 1;
        backendTotal = response.total;
        rowsScanned += response.records.length;

        for (const rawRow of response.records) {
          const row = normalizeRow(rawRow, source.fields);
          if (!rowMatchesFilters(row, filters)) continue;
          consume(row, operation, groupBy, valueField, state);
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

  if (!complete && nextCursor === null) {
    return fail(tool, "SCAN_LIMIT_REACHED", "Aggregation scan cap was reached and the continuation cursor would exceed the response budget.", "Narrow filters or lower grouping cardinality.", {
      affected_sources: [source.source_key],
      partial: {
        data: materialize(operation, state, topN),
        meta: {
          ...baseMeta([source.source_key], [sourceAttribution(source, datasetIds[datasetIndex])], source.caveats),
          rows_scanned: rowsScanned,
          pages_scanned: pagesScanned,
          backend_total: backendTotal,
          complete,
          truncated: true,
          next_cursor: null
        }
      }
    });
  }

  if (operation === "top_n_by_count" && !complete && !input.allow_partial) {
    return fail(tool, "PARTIAL_RANKING_REFUSED", "Top-N ranking is partial because the scan cap was reached.", "Narrow filters, continue with next_cursor, or set allow_partial=true.", {
      affected_sources: [source.source_key],
      partial: {
        data: materialize(operation, state, topN),
        meta: {
          ...baseMeta([source.source_key], [sourceAttribution(source, datasetIds[datasetIndex])], source.caveats),
          rows_scanned: rowsScanned,
          pages_scanned: pagesScanned,
          backend_total: backendTotal,
          complete,
          truncated: !complete,
          next_cursor: nextCursor
        }
      }
    });
  }

  return ok(
    tool,
    {
      operation,
      result: materialize(operation, state, topN)
    },
    {
      ...baseMeta([source.source_key], [sourceAttribution(source, datasetIds[datasetIndex])], source.caveats),
      rows_scanned: rowsScanned,
      pages_scanned: pagesScanned,
      backend_total: backendTotal,
      complete,
      truncated: !complete,
      next_cursor: nextCursor
    }
  );
}

function consume(
  row: Record<string, unknown>,
  operation: AggregateHousingRowsInput["operation"],
  groupBy: string[],
  valueField: string | undefined,
  state: AggregateState
): void {
  state.count += 1;
  if (operation === "group_count" || operation === "top_n_by_count") {
    const keyObject = Object.fromEntries(groupBy.map((field) => [field, row[field] ?? null]));
    const key = JSON.stringify(keyObject);
    state.groups[key] ??= { key: keyObject, count: 0 };
    state.groups[key].count += 1;
  }
  if (operation === "numeric_summary" && valueField) {
    const value = row[valueField];
    if (typeof value === "number" && Number.isFinite(value)) state.values.push(value);
  }
}

function materialize(operation: AggregateHousingRowsInput["operation"], state: AggregateState, topN: number): unknown {
  if (operation === "count") return { count: state.count };
  if (operation === "group_count" || operation === "top_n_by_count") {
    return Object.values(state.groups)
      .sort((a, b) => b.count - a.count)
      .slice(0, operation === "top_n_by_count" ? topN : undefined)
      .map((entry) => ({ ...entry.key, count: entry.count }));
  }
  return numericSummary(state.values);
}

function numericSummary(values: number[]): Record<string, number | null> {
  if (values.length === 0) {
    return { count: 0, min: null, max: null, avg: null, median: null, p25: null, p75: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
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

function percentile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function boundedCursor(payload: Record<string, unknown>): string | null {
  const cursor = encodeCursor(payload);
  return cursor.length <= MAX_CURSOR_CHARS ? cursor : null;
}
