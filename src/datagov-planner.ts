import { normalizeFilters, resolveFilterAliases } from "./filters.js";
import { requireSource } from "./registry.js";
import type { HousingFilters, SourceKey } from "./types.js";

export type DataGovScanPlan = {
  datasetIds: string[];
  sort?: string;
  stopAfterFieldBelow?: {
    field: string;
    value: string;
  };
};

const HDB_RESALE_DATASET_SPANS: Record<string, { start: string; end: string | null }> = {
  d_ebc5ab87086db484f88045b47411ebc5: { start: "1990-01", end: "1999-12" },
  d_43f493c6c50d54243cc1eab0df142d6a: { start: "2000-01", end: "2012-02" },
  d_2d5ff9ea31397b66239f245f57751537: { start: "2012-03", end: "2014-12" },
  d_ea9ed51da2787afaf8e51f827c304208: { start: "2015-01", end: "2016-12" },
  d_8b84c4ee58e3cfc0ece0d773c8ca6abc: { start: "2017-01", end: null }
};

const UPPERCASE_SERVER_FILTERS: Partial<Record<SourceKey, Set<string>>> = {
  hdb_resale_transactions: new Set(["town", "flat_type", "street_name", "flat_model", "storey_range"]),
  hdb_rental_transactions: new Set(["town", "flat_type", "street_name"]),
  hdb_median_resale: new Set(["town", "flat_type"]),
  hdb_median_rent: new Set(["town", "flat_type"]),
  cea_salespersons: new Set(["salesperson_name", "estate_agent_name"]),
  cea_residential_transactions: new Set(["salesperson_name", "property_type", "transaction_type", "represented", "town"])
};

const DERIVED_FIELDS: Partial<Record<SourceKey, Set<string>>> = {
  hdb_resale_transactions: new Set(["remaining_lease_months", "quarter", "year", "remaining_lease_bucket", "price_psm"])
};

export function planDataGovScan(sourceKey: SourceKey, datasetIds: string[], filters: HousingFilters | undefined): DataGovScanPlan {
  if (sourceKey !== "hdb_resale_transactions") return { datasetIds };

  const monthRange = rangeForField(filters, "month");
  if (!monthRange) return { datasetIds };

  const selected = datasetIds.filter((datasetId) => {
    const span = HDB_RESALE_DATASET_SPANS[datasetId];
    if (!span) return true;
    if (monthRange.gte && span.end && span.end < monthRange.gte) return false;
    if (monthRange.lte && span.start > monthRange.lte) return false;
    return true;
  });
  const pruned = selected.length > 0 ? selected : datasetIds;

  if (monthRange.gte) {
    return {
      datasetIds: sortHdbResaleNewestFirst(pruned),
      sort: "month desc",
      stopAfterFieldBelow: { field: "month", value: monthRange.gte }
    };
  }

  return { datasetIds: pruned };
}

export function exactServerFilters(
  sourceKey: SourceKey,
  filters: HousingFilters | undefined
): Record<string, string | number | Array<string | number>> | undefined {
  const source = requireSource(sourceKey);
  const resolved = normalizeDataGovFilterValues(sourceKey, resolveFilterAliases(source.fields, filters));
  const serverFilters: Record<string, string | number | Array<string | number>> = {};
  for (const filter of normalizeFilters(resolved)) {
    if (DERIVED_FIELDS[sourceKey]?.has(filter.field)) continue;
    if (filter.op !== "eq" && filter.op !== "in") continue;
    if (typeof filter.value === "boolean") continue;
    if (Array.isArray(filter.value)) {
      const values = filter.value
        .filter((value): value is string | number => typeof value !== "boolean")
        .map((value) => normalizeServerFilterValue(sourceKey, filter.field, value));
      if (values.length > 0) serverFilters[filter.field] = values;
    } else {
      serverFilters[filter.field] = normalizeServerFilterValue(sourceKey, filter.field, filter.value);
    }
  }
  return Object.keys(serverFilters).length > 0 ? serverFilters : undefined;
}

export function normalizeDataGovFilterValues(sourceKey: SourceKey, filters: HousingFilters | undefined): HousingFilters | undefined {
  if (!filters) return undefined;
  const normalized: HousingFilters = {};
  for (const [fieldName, condition] of Object.entries(filters)) {
    if (Array.isArray(condition)) {
      normalized[fieldName] = condition.map((value) => normalizeFilterPrimitive(sourceKey, fieldName, value));
      continue;
    }
    if (typeof condition !== "object" || condition === null) {
      normalized[fieldName] = normalizeFilterPrimitive(sourceKey, fieldName, condition);
      continue;
    }
    if ("op" in condition) {
      normalized[fieldName] =
        condition.op === "eq" || condition.op === "in"
          ? {
              op: condition.op,
              value: Array.isArray(condition.value)
                ? condition.value.map((value) => normalizeFilterPrimitive(sourceKey, fieldName, value))
                : normalizeFilterPrimitive(sourceKey, fieldName, condition.value)
            }
          : condition;
      continue;
    }
    normalized[fieldName] = condition;
  }
  return normalized;
}

function normalizeServerFilterValue(sourceKey: SourceKey, field: string, value: string | number): string | number {
  if (typeof value !== "string") return value;
  if (sourceKey.startsWith("hdb_") && field === "flat_type") return normalizeHdbFlatType(value);
  if (!UPPERCASE_SERVER_FILTERS[sourceKey]?.has(field)) return value;
  const upper = value.toUpperCase();
  return sourceKey.startsWith("hdb_") && field === "street_name" ? normalizeHdbStreetName(upper) : upper;
}

function normalizeFilterPrimitive(sourceKey: SourceKey, field: string, value: string | number | boolean): string | number | boolean {
  if (typeof value === "boolean") return value;
  return normalizeServerFilterValue(sourceKey, field, value);
}

function rangeForField(filters: HousingFilters | undefined, field: string): { gte?: string; lte?: string } | null {
  const range: { gte?: string; lte?: string } = {};
  for (const filter of normalizeFilters(filters)) {
    if (filter.field !== field || Array.isArray(filter.value)) continue;
    if (filter.op === "gte") range.gte = String(filter.value);
    if (filter.op === "lte") range.lte = String(filter.value);
  }
  return range.gte || range.lte ? range : null;
}

function sortHdbResaleNewestFirst(datasetIds: string[]): string[] {
  return [...datasetIds].sort((a, b) => {
    const left = HDB_RESALE_DATASET_SPANS[a];
    const right = HDB_RESALE_DATASET_SPANS[b];
    return (right?.start ?? "").localeCompare(left?.start ?? "");
  });
}

function normalizeHdbStreetName(value: string): string {
  const replacements: Record<string, string> = {
    AVENUE: "AVE",
    CRESCENT: "CRES",
    CLOSE: "CL",
    DRIVE: "DR",
    HEIGHTS: "HTS",
    LORONG: "LOR",
    PLACE: "PL",
    ROAD: "RD",
    STREET: "ST",
    TERRACE: "TER"
  };
  return value
    .split(/\s+/)
    .map((part) => replacements[part] ?? part)
    .join(" ");
}

export function normalizeHdbFlatType(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/-/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    "1 ROOM": "1 ROOM",
    "ONE ROOM": "1 ROOM",
    "2 ROOM": "2 ROOM",
    "TWO ROOM": "2 ROOM",
    "3 ROOM": "3 ROOM",
    "THREE ROOM": "3 ROOM",
    "4 ROOM": "4 ROOM",
    "FOUR ROOM": "4 ROOM",
    "5 ROOM": "5 ROOM",
    "FIVE ROOM": "5 ROOM",
    EXEC: "EXECUTIVE",
    EXECUTIVE: "EXECUTIVE",
    "EXECUTIVE APARTMENT": "EXECUTIVE",
    "EXECUTIVE MAISONETTE": "EXECUTIVE",
    "MULTI GENERATION": "MULTI-GENERATION",
    "MULTI-GENERATION": "MULTI-GENERATION",
    "MULTI GEN": "MULTI-GENERATION"
  };
  return aliases[normalized] ?? normalized;
}
