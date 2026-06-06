import { describe, expect, it } from "vitest";
import { aggregateHousingRows } from "./aggregate.js";
import { encodeCursor } from "./cursor.js";
import { DataGovClient } from "./datagov-client.js";
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

  it("derives remaining lease months for HDB resale rows", () => {
    const row = normalizeRow({ remaining_lease: "61 years 04 months" }, [
      { name: "remaining_lease", type: "string" },
      { name: "remaining_lease_months", type: "number" }
    ]);
    expect(row.remaining_lease_months).toBe(736);

    const legacyRow = normalizeRow({ remaining_lease: "83" }, [
      { name: "remaining_lease", type: "string" },
      { name: "remaining_lease_months", type: "number" }
    ]);
    expect(legacyRow.remaining_lease_months).toBe(996);
  });
});

describe("data.gov.sg client transport", () => {
  it("uses the maintained data.gov.sg proxy by default", async () => {
    const oldFetch = globalThis.fetch;
    const oldProxy = process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
    const oldDirect = process.env.SG_HOUSING_DATA_GOV_DIRECT;
    const oldKey = process.env.DATA_GOV_SG_API_KEY;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    process.env.SG_HOUSING_DATA_GOV_PROXY_URL = "https://example.test/api/data-gov";
    delete process.env.SG_HOUSING_DATA_GOV_DIRECT;
    delete process.env.DATA_GOV_SG_API_KEY;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ success: true, result: { records: [], total: 0, resource_id: "test" } }), { status: 200 });
    }) as typeof fetch;

    await new DataGovClient().searchRows({ resourceId: "test", limit: 10, offset: 5, filters: { town: "A" }, sort: "month desc" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.test/api/data-gov");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      resource_id: "test",
      limit: 10,
      offset: 5,
      filters: { town: "A" },
      sort: "month desc"
    });

    globalThis.fetch = oldFetch;
    restoreDataGovEnv(oldProxy, oldDirect, oldKey);
  });

  it("can use direct data.gov.sg API key mode for development", async () => {
    const oldFetch = globalThis.fetch;
    const oldProxy = process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
    const oldDirect = process.env.SG_HOUSING_DATA_GOV_DIRECT;
    const oldKey = process.env.DATA_GOV_SG_API_KEY;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    delete process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
    process.env.SG_HOUSING_DATA_GOV_DIRECT = "1";
    process.env.DATA_GOV_SG_API_KEY = "dev-key";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ success: true, result: { records: [], total: 0, resource_id: "test" } }), { status: 200 });
    }) as typeof fetch;

    await new DataGovClient().searchRows({ resourceId: "test", limit: 10 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("https://data.gov.sg/api/action/datastore_search");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("dev-key");

    globalThis.fetch = oldFetch;
    restoreDataGovEnv(oldProxy, oldDirect, oldKey);
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

function restoreDataGovEnv(oldProxy: string | undefined, oldDirect: string | undefined, oldKey: string | undefined): void {
  if (oldProxy === undefined) delete process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
  else process.env.SG_HOUSING_DATA_GOV_PROXY_URL = oldProxy;
  if (oldDirect === undefined) delete process.env.SG_HOUSING_DATA_GOV_DIRECT;
  else process.env.SG_HOUSING_DATA_GOV_DIRECT = oldDirect;
  if (oldKey === undefined) delete process.env.DATA_GOV_SG_API_KEY;
  else process.env.DATA_GOV_SG_API_KEY = oldKey;
}

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

  it("pushes exact filters and recent HDB resale sort into data.gov.sg scans", async () => {
    const calls: Array<{ resourceId: string; filters?: unknown; sort?: string; offset?: number }> = [];
    const fakeClient = {
      async searchRows(params: { resourceId: string; filters?: unknown; sort?: string; offset?: number }) {
        calls.push(params);
        return {
          records: [
            {
              month: "2026-05",
              town: "BUKIT MERAH",
              flat_type: "5 ROOM",
              street_name: "BOON TIONG RD",
              remaining_lease: "74 years 01 month",
              resale_price: "1000000"
            },
            {
              month: "2026-02",
              town: "BUKIT MERAH",
              flat_type: "5 ROOM",
              street_name: "BOON TIONG RD",
              remaining_lease: "74 years 04 months",
              resale_price: "900000"
            }
          ],
          total: 2,
          resource_id: params.resourceId
        };
      }
    };

    const result = await aggregateHousingRows(
      {
        source: "hdb_resale_transactions",
        operation: "numeric_summary",
        filters: {
          street_name: "Boon Tiong Road",
          flat_type: "5 room",
          month_gte: "2026-03"
        },
        value_field: "resale_price",
        group_by: ["remaining_lease_months"],
        limit_rows_scanned: 500
      },
      fakeClient as never
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resourceId).toBe("d_8b84c4ee58e3cfc0ece0d773c8ca6abc");
    expect(calls[0]?.sort).toBe("month desc");
    expect(calls[0]?.filters).toEqual({ street_name: "BOON TIONG RD", flat_type: "5 ROOM" });
    expect(result.meta.complete).toBe(true);
    expect(result.data.result).toEqual([
      {
        remaining_lease_months: 889,
        count: 1,
        min: 1000000,
        max: 1000000,
        avg: 1000000,
        median: 1000000,
        p25: 1000000,
        p75: 1000000
      }
    ]);
  });

  it("returns grouped numeric summaries capped by top_n", async () => {
    const fakeClient = {
      async searchRows() {
        return {
          records: [
            { quarter: "2024-Q1", town: "A", flat_type: "4 ROOM", price: "10" },
            { quarter: "2024-Q1", town: "A", flat_type: "4 ROOM", price: "20" },
            { quarter: "2024-Q1", town: "B", flat_type: "4 ROOM", price: "30" }
          ],
          total: 3,
          resource_id: "test"
        };
      }
    };

    const result = await aggregateHousingRows(
      {
        source: "hdb_median_resale",
        operation: "numeric_summary",
        group_by: ["town"],
        value_field: "price",
        top_n: 1
      },
      fakeClient as never
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.result).toEqual([{ town: "A", count: 2, min: 10, max: 20, avg: 15, median: 15, p25: 12.5, p75: 17.5 }]);
  });
});
