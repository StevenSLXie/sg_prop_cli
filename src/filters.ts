import type { FieldCatalogEntry, FilterCondition, FilterOperator, HousingFilters } from "./types.js";

export type NormalizedFilter = {
  field: string;
  op: FilterOperator;
  value: string | number | boolean | Array<string | number | boolean>;
};

export function normalizeFilters(filters: HousingFilters | undefined): NormalizedFilter[] {
  if (!filters) return [];

  return Object.entries(filters).flatMap(([rawFieldName, condition]) => {
    const suffix = suffixOperator(rawFieldName);
    const fieldName = suffix ? rawFieldName.slice(0, -`_${suffix}`.length) : rawFieldName;
    if (suffix) {
      return [{ field: fieldName, op: suffix, value: condition as string | number | boolean | Array<string | number | boolean> }];
    }

    if (Array.isArray(condition)) {
      return [{ field: fieldName, op: "in" as const, value: condition }];
    }

    if (typeof condition !== "object" || condition === null) {
      return [{ field: fieldName, op: "eq" as const, value: condition }];
    }

    if ("op" in condition) {
      return [{ field: fieldName, op: condition.op, value: condition.value }];
    }

    const rangeFilters: NormalizedFilter[] = [];
    if (condition.gte !== undefined) {
      rangeFilters.push({ field: fieldName, op: "gte", value: condition.gte });
    }
    if (condition.lte !== undefined) {
      rangeFilters.push({ field: fieldName, op: "lte", value: condition.lte });
    }
    return rangeFilters;
  });
}

export function validateFilters(fields: FieldCatalogEntry[], filters: HousingFilters | undefined): string[] {
  const errors: string[] = [];
  const catalog = new Map(fields.map((field) => [field.name, field]));
  for (const [fieldName, condition] of Object.entries(filters ?? {})) {
    const suffix = suffixOperator(fieldName);
    if (suffix) {
      if (Array.isArray(condition) || (typeof condition === "object" && condition !== null)) {
        errors.push(`Suffix filter '${fieldName}' requires a single value.`);
      }
      continue;
    }
    if (Array.isArray(condition) || typeof condition !== "object" || condition === null) continue;
    if ("op" in condition) {
      if (!("value" in condition) || condition.value === undefined || condition.value === null) {
        errors.push(`Operator '${condition.op}' for field '${fieldName}' requires value.`);
      }
      continue;
    }
    if (condition.gte === undefined && condition.lte === undefined) {
      errors.push(`Range filter for field '${fieldName}' requires gte or lte.`);
    }
  }
  for (const filter of normalizeFilters(filters)) {
    const field = catalog.get(filter.field);
    if (!field) {
      errors.push(`Unknown filter field '${filter.field}'.`);
      continue;
    }
    if (!field.filterable || !field.operators.includes(filter.op)) {
      errors.push(`Field '${filter.field}' does not support operator '${filter.op}'.`);
    }
    if (filter.op === "in" && !Array.isArray(filter.value)) {
      errors.push(`Operator 'in' for field '${filter.field}' requires an array value.`);
    }
    if (filter.op !== "in" && Array.isArray(filter.value)) {
      errors.push(`Operator '${filter.op}' for field '${filter.field}' requires a single value.`);
    }
  }
  return errors;
}

function suffixOperator(fieldName: string): "gte" | "lte" | null {
  if (fieldName.endsWith("_gte")) return "gte";
  if (fieldName.endsWith("_lte")) return "lte";
  return null;
}

export function coerceComparable(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "na" || text === "-") return null;
  const numeric = Number(text.replace(/,/g, ""));
  if (!Number.isNaN(numeric) && /^-?\d[\d,.]*$/.test(text)) return numeric;
  return text;
}

export function rowMatchesFilters(row: Record<string, unknown>, filters: HousingFilters | undefined): boolean {
  return normalizeFilters(filters).every((filter) => {
    const actual = coerceComparable(row[filter.field]);
    if (actual === null) return false;

    switch (filter.op) {
      case "eq":
        return compareEquals(actual, filter.value);
      case "in":
        return Array.isArray(filter.value) && filter.value.some((value) => compareEquals(actual, value));
      case "contains":
        return String(actual).toLowerCase().includes(String(filter.value).toLowerCase());
      case "gte":
        return compareOrder(actual, filter.value) >= 0;
      case "lte":
        return compareOrder(actual, filter.value) <= 0;
    }
  });
}

function compareEquals(actual: string | number | boolean, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected !== "boolean") {
    const expectedNumber = Number(String(expected).replace(/,/g, ""));
    return !Number.isNaN(expectedNumber) && actual === expectedNumber;
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function compareOrder(actual: string | number | boolean, expected: unknown): number {
  if (typeof actual === "number") {
    const expectedNumber = Number(String(expected).replace(/,/g, ""));
    if (Number.isNaN(expectedNumber)) return -1;
    return actual - expectedNumber;
  }
  return String(actual).localeCompare(String(expected));
}
