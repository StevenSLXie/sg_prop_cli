import { describe, expect, it } from "vitest";
import { aggregateHousingRows } from "./aggregate.js";
import { encodeCursor } from "./cursor.js";
import { rowMatchesFilters } from "./filters.js";
import { queryHousingRows, normalizeRow } from "./query.js";

describe("row filters", () => {
  it("supports eq, in, contains, and range filters", () => {
    const row = { town: "ANG MO KIO", price_psf: 2100, project: "THE MINTON" };
    expect(rowMatchesFilters(row, { town: "ANG MO KIO" })).toBe(true);
    expect(rowMatchesFilters(row, { town: ["BISHAN", "ANG MO KIO"] })).toBe(true);
    expect(rowMatchesFilters(row, { project: { op: "contains", value: "minton" } })).toBe(true);
    expect(rowMatchesFilters(row, { price_psf: { gte: 2000, lte: 2200 } })).toBe(true);
    expect(rowMatchesFilters(row, { price_psf_gte: 2000, price_psf_lte: 2200 })).toBe(true);
    expect(rowMatchesFilters(row, { price_psf: { gte: 2201 } })).toBe(false);
    expect(rowMatchesFilters(row, { price_psf_gte: 2201 })).toBe(false);
  });

  it("rejects invalid in value shape", () => {
    expect(rowMatchesFilters({ town: "ANG MO KIO" }, { town: { op: "in", value: "ANG MO KIO" } })).toBe(false);
  });

  it("rejects missing operator values through query validation", async () => {
    const result = await queryHousingRows({
      source: "hdb_median_resale",
      filters: { price: { op: "lte" } as never },
      limit: 1
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts agent-style _gte and _lte filter suffixes through query validation", async () => {
    const fakeClient = {
      async searchRows() {
        return {
          records: [
            { quarter: "2023-Q4", town: "A", flat_type: "4 ROOM", price: "1" },
            { quarter: "2024-Q1", town: "B", flat_type: "4 ROOM", price: "2" },
            { quarter: "2024-Q2", town: "C", flat_type: "4 ROOM", price: "3" }
          ],
          total: 3,
          resource_id: "test"
        };
      }
    };
    const result = await queryHousingRows(
      {
        source: "hdb_median_resale",
        filters: { quarter_gte: "2024-Q1", quarter_lte: "2024-Q2" },
        select: ["quarter", "town", "price"],
        limit: 10
      },
      fakeClient as never
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((row) => row.quarter)).toEqual(["2024-Q1", "2024-Q2"]);
  });

  it("normalizes numeric fields", () => {
    const row = normalizeRow({ resale_price: "500,000", town: "QUEENSTOWN" }, [
      { name: "resale_price", type: "number" },
      { name: "town", type: "string" }
    ]);
    expect(row.resale_price).toBe(500000);
    expect(row.town).toBe("QUEENSTOWN");
  });
});

describe("query cursor", () => {
  it("continues within the same backend page without dropping rows", async () => {
    const fakeClient = {
      async searchRows(params: { limit: number; offset?: number }) {
        const records = [
          { quarter: "2024-Q1", town: "A", flat_type: "4 ROOM", price: "1" },
          { quarter: "2024-Q1", town: "B", flat_type: "4 ROOM", price: "2" },
          { quarter: "2024-Q1", town: "C", flat_type: "4 ROOM", price: "3" },
          { quarter: "2024-Q1", town: "D", flat_type: "4 ROOM", price: "4" }
        ];
        const offset = params.offset ?? 0;
        return {
          records: records.slice(offset, offset + params.limit),
          total: records.length,
          resource_id: "test"
        };
      }
    };
    const first = await queryHousingRows({ source: "hdb_median_resale", limit: 2 }, fakeClient as never);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.rows.map((row) => row.town)).toEqual(["A", "B"]);
    const second = await queryHousingRows({ source: "hdb_median_resale", cursor: first.meta.next_cursor ?? undefined, limit: 2 }, fakeClient as never);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.rows.map((row) => row.town)).toEqual(["C", "D"]);
  });

  it("rejects cursor dataset index outside the source datasets", async () => {
    const cursor = encodeCursor({
      kind: "row",
      source: "hdb_median_resale",
      dataset_index: 999,
      offset: 0,
      rows_scanned: 0,
      pages_scanned: 0
    });
    const result = await queryHousingRows({ source: "hdb_median_resale", cursor });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("aggregate cursor", () => {
  it("continues scanning after a partial aggregation cursor", async () => {
    const fakeClient = {
      async searchRows(params: { limit: number; offset?: number }) {
        const records = [
          { quarter: "2024-Q1", town: "A", flat_type: "4 ROOM", price: "1" },
          { quarter: "2024-Q1", town: "B", flat_type: "4 ROOM", price: "2" },
          { quarter: "2024-Q1", town: "C", flat_type: "4 ROOM", price: "3" },
          { quarter: "2024-Q1", town: "D", flat_type: "4 ROOM", price: "4" }
        ];
        const offset = params.offset ?? 0;
        return {
          records: records.slice(offset, offset + params.limit),
          total: records.length,
          resource_id: "test"
        };
      }
    };
    const first = await aggregateHousingRows(
      { source: "hdb_median_resale", operation: "count", limit_rows_scanned: 2 },
      fakeClient as never
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.result).toEqual({ count: 2 });
    expect(first.meta.next_cursor).toBeTruthy();
    const second = await aggregateHousingRows(
      { source: "hdb_median_resale", operation: "count", cursor: first.meta.next_cursor ?? undefined, limit_rows_scanned: 2 },
      fakeClient as never
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.result).toEqual({ count: 4 });
  });
});
