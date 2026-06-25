import { normalizeFilters } from "./filters.js";
import type { FieldCatalogEntry, HousingFilters } from "./types.js";

const METRIC_SUFFIXES = ["median", "p25", "p75", "avg", "min", "max"];

export type AnalysisValidationInput = {
  fields: FieldCatalogEntry[];
  derivedFields?: FieldCatalogEntry[];
  groupBy: string[];
  metrics: string[];
  filters?: HousingFilters[];
};

export function validateAnalysisInput(input: AnalysisValidationInput): string[] {
  const allowed = new Map([...input.fields, ...(input.derivedFields ?? [])].map((field) => [field.name, field]));
  const errors: string[] = [];

  for (const field of input.groupBy) {
    if (!allowed.has(field)) errors.push(`Unknown group_by field '${field}'.`);
  }

  for (const metric of input.metrics) {
    if (metric === "count") continue;
    const field = metricField(metric);
    if (!field) {
      errors.push(`Unsupported analysis metric '${metric}'.`);
      continue;
    }
    const entry = allowed.get(field);
    if (!entry) errors.push(`Unknown metric field '${field}' in '${metric}'.`);
    else if (entry.type !== "number") errors.push(`Metric '${metric}' requires numeric field '${field}'.`);
  }

  for (const filters of input.filters ?? []) {
    for (const filter of normalizeFilters(filters)) {
      const entry = allowed.get(filter.field);
      if (!entry) {
        errors.push(`Unknown filter field '${filter.field}'.`);
        continue;
      }
      if (!entry.filterable || !entry.operators.includes(filter.op)) {
        errors.push(`Field '${filter.field}' does not support operator '${filter.op}'.`);
      }
      if (filter.op === "in" && !Array.isArray(filter.value)) {
        errors.push(`Operator 'in' for field '${filter.field}' requires an array value.`);
      }
      if (filter.op !== "in" && Array.isArray(filter.value)) {
        errors.push(`Operator '${filter.op}' for field '${filter.field}' requires a single value.`);
      }
    }
  }

  return errors;
}

export function analysisField(
  name: string,
  type: FieldCatalogEntry["type"],
  operators: FieldCatalogEntry["operators"] = ["eq", "in", "contains", "gte", "lte"]
): FieldCatalogEntry {
  return {
    name,
    type,
    filterable: operators.length > 0,
    operators,
    sortable: false
  };
}

function metricField(metric: string): string | null {
  for (const suffix of METRIC_SUFFIXES) {
    const marker = `_${suffix}`;
    if (metric.endsWith(marker) && metric.length > marker.length) return metric.slice(0, -marker.length);
  }
  return null;
}
