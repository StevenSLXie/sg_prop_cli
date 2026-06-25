import { describe, expect, it } from "vitest";
import { analyzeHdbResaleRows, analyzeHdbResaleTransactions, deriveHdbResaleAnalysisFields, remainingLeaseBucket } from "./hdb-analysis.js";

describe("HDB resale analysis adapter", () => {
  it("prunes datasets, pushes exact filters, normalizes flat type aliases, and analyzes in one scan", async () => {
    const calls: Record<string, unknown>[] = [];
    const fakeClient = {
      async searchRows(params: Record<string, unknown>) {
        calls.push(params);
        return {
          records: [
            hdbRow({ month: "2025-03", resale_price: "500000", floor_area_sqm: "100", remaining_lease: "80 years" }),
            hdbRow({ month: "2025-02", resale_price: "550000", floor_area_sqm: "110", remaining_lease: "79 years 6 months" })
          ],
          total: 2,
          resource_id: String(params.resourceId)
        };
      }
    };

    const result = await analyzeHdbResaleRows(
      {
        filters: {
          month: { gte: "2025-01" },
          town: "queenstown",
          flat_type: "three room",
          street_name: "commonwealth avenue"
        },
        group_by: ["town", "flat_type", "quarter"],
        segments: [{ name: "all" }, { name: "three_room", filters: { flat_type: "3-room" } }],
        metrics: ["count", "resale_price_median", "price_psm_median", "remaining_lease_months_median"],
        limit_rows_scanned: 10
      },
      fakeClient as never
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        resourceId: "d_8b84c4ee58e3cfc0ece0d773c8ca6abc",
        sort: "month desc",
        filters: {
          town: "QUEENSTOWN",
          flat_type: "3 ROOM",
          street_name: "COMMONWEALTH AVE"
        }
      })
    );
    expect(result.scan.dataset_ids).toEqual(["d_8b84c4ee58e3cfc0ece0d773c8ca6abc"]);
    expect(result.scan.complete).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({
        town: "QUEENSTOWN",
        flat_type: "3 ROOM",
        quarter: "2025-Q1",
        segment: "all",
        count: 2,
        resale_price_median: 525000,
        price_psm_median: 5000,
        remaining_lease_months_median: 957
      }),
      expect.objectContaining({
        town: "QUEENSTOWN",
        flat_type: "3 ROOM",
        quarter: "2025-Q1",
        segment: "three_room",
        count: 2
      })
    ]);
  });

  it("derives stable lease buckets, quarter, year, and price per sqm", () => {
    expect(remainingLeaseBucket(0)).toBe("000-119 months");
    expect(remainingLeaseBucket(120)).toBe("120-239 months");
    expect(remainingLeaseBucket(959)).toBe("840-959 months");

    expect(
      deriveHdbResaleAnalysisFields({
        month: "2026-06",
        resale_price: 600000,
        floor_area_sqm: 120,
        remaining_lease_months: 959
      })
    ).toEqual(
      expect.objectContaining({
        year: "2026",
        quarter: "2026-Q2",
        remaining_lease_bucket: "840-959 months",
        price_psm: 5000
      })
    );
  });

  it("refuses authoritative output when scan cap is reached and allow_partial is false", async () => {
    const fakeClient = partialFakeClient();

    const result = await analyzeHdbResaleTransactions(
      {
        filters: { month: { gte: "2025-01" } },
        group_by: ["town"],
        metrics: ["count", "resale_price_median"],
        limit_rows_scanned: 1
      },
      fakeClient as never
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SCAN_LIMIT_REACHED");
    expect(result.partial?.data).toBeUndefined();
    expect(result.partial?.meta).toEqual(
      expect.objectContaining({
        rows_scanned: 1,
        complete: false,
        truncated: true,
        next_cursor: null
      })
    );
  });

  it("returns explicit partial output when allow_partial is true", async () => {
    const fakeClient = partialFakeClient();

    const result = await analyzeHdbResaleTransactions(
      {
        filters: { month: { gte: "2025-01" } },
        group_by: ["town"],
        metrics: ["count", "resale_price_median"],
        limit_rows_scanned: 1,
        allow_partial: true
      },
      fakeClient as never
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.partial).toBe(true);
    expect(result.data.rows).toEqual([expect.objectContaining({ town: "QUEENSTOWN", segment: "all", count: 1, resale_price_median: 500000 })]);
    expect(result.data.diagnostics).toEqual(expect.objectContaining({ matching_rows: 1, scan_complete: false }));
    expect(result.meta).toEqual(
      expect.objectContaining({
        rows_returned: 1,
        rows_scanned: 1,
        complete: false,
        truncated: true,
        next_cursor: null
      })
    );
  });

  it("returns validation errors when output caps are exceeded", async () => {
    const fakeClient = {
      async searchRows(params: Record<string, unknown>) {
        return {
          records: [
            hdbRow({ town: "QUEENSTOWN" }),
            hdbRow({ town: "TOA PAYOH" })
          ],
          total: 2,
          resource_id: String(params.resourceId)
        };
      }
    };

    const result = await analyzeHdbResaleTransactions(
      {
        filters: { month: { gte: "2025-01" } },
        group_by: ["town"],
        metrics: ["count"],
        max_output_rows: 1
      },
      fakeClient as never
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

function hdbRow(overrides: Record<string, unknown>) {
  return {
    month: "2025-03",
    town: "QUEENSTOWN",
    flat_type: "3 ROOM",
    block: "1",
    street_name: "COMMONWEALTH AVE",
    storey_range: "10 TO 12",
    floor_area_sqm: "100",
    flat_model: "Improved",
    lease_commence_date: "2005",
    remaining_lease: "80 years",
    resale_price: "500000",
    ...overrides
  };
}

function partialFakeClient() {
  return {
    async searchRows(params: Record<string, unknown>) {
      return {
        records: [hdbRow({ month: "2025-03", resale_price: "500000" })],
        total: 2,
        resource_id: String(params.resourceId)
      };
    }
  };
}
