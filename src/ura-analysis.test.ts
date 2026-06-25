import { describe, expect, it } from "vitest";
import { analyzePrivateResidentialSales } from "./ura-analysis.js";

describe("URA private residential sales analysis", () => {
  it("analyzes five projects across six quarters while invoking only resolved batches once", async () => {
    const calls: number[] = [];
    const fakeClient = {
      async invoke(_service: string, params: Record<string, unknown>) {
        const batch = Number(params.batch);
        calls.push(batch);
        if (batch === 1) {
          return {
            Status: "Success",
            Result: [projectPayload("NORMANTON PARK", "NORMANTON PARK", "RCR", "05", 100, 1_600_000), projectPayload("PARC RIVIERA", "WEST COAST VALE", "OCR", "05", 88, 1_200_000)]
          };
        }
        if (batch === 2) {
          return {
            Status: "Success",
            Result: [
              projectPayload("PARC ESTA", "SIMS AVENUE", "RCR", "14", 82, 1_350_000),
              projectPayload("D'LEEDON", "LEEDON HEIGHTS", "CCR", "10", 115, 2_100_000),
              projectPayload("SIMS URBAN OASIS", "SIMS DRIVE", "RCR", "14", 95, 1_500_000)
            ]
          };
        }
        throw new Error(`Unexpected batch ${batch}`);
      }
    };

    const result = await analyzePrivateResidentialSales(
      {
        projects: ["PARC RIVIERA", "NORMANTON PARK", "PARC ESTA", "D'LEEDON", "SIMS URBAN OASIS"],
        from: "2025-01",
        to: "2026-06",
        group_by: ["project", "quarter"],
        segments: [
          { name: "all" },
          {
            name: "large",
            filters: { area_sqm: { gte: 90 } },
            proxy_for: "3 bedrooms or larger",
            unavailable_field: "bedrooms",
            proxy_field: "area_sqm"
          }
        ],
        metrics: ["count", "price_median", "price_psf_median", "area_sqm_median"],
        output: "long_table",
        max_output_rows: 100
      },
      fakeClient as never
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([1, 2]);
    expect(result.meta.batches_scanned).toBe(2);
    expect(result.meta.rows_scanned).toBe(30);
    expect(result.data.diagnostics).toEqual(
      expect.objectContaining({
        batches_requested: [1, 2],
        matching_rows: 30
      })
    );
    expect(result.data.diagnostics.candidate_plan).toEqual(
      expect.objectContaining({
        batches: [1, 2]
      })
    );
    expect(result.data.diagnostics.candidate_plan).not.toHaveProperty("broad_scan_reason");
    expect(result.data.assumptions).toEqual([
      expect.objectContaining({
        code: "BEDROOMS_UNAVAILABLE_AREA_PROXY",
        segment: "large",
        unavailable_field: "bedrooms",
        proxy_field: "area_sqm"
      })
    ]);
    expect(result.data.rows).toContainEqual(
      expect.objectContaining({
        project: "NORMANTON PARK",
        quarter: "2025-Q1",
        segment: "all",
        count: 1,
        price_median: 1_600_000,
        area_sqm_median: 100
      })
    );
    expect(result.data.rows).toContainEqual(
      expect.objectContaining({
        project: "NORMANTON PARK",
        quarter: "2025-Q1",
        segment: "large",
        count: 1
      })
    );
    expect(result.data.rows).not.toContainEqual(
      expect.objectContaining({
        project: "PARC ESTA",
        quarter: "2025-Q1",
        segment: "large"
      })
    );
  });

  it("returns validation errors for oversized analysis output", async () => {
    const fakeClient = {
      async invoke() {
        return {
          Status: "Success",
          Result: [projectPayload("NORMANTON PARK", "NORMANTON PARK", "RCR", "05", 100, 1_600_000)]
        };
      }
    };

    const result = await analyzePrivateResidentialSales(
      {
        projects: ["NORMANTON PARK"],
        group_by: ["project", "quarter"],
        segments: [{ name: "all" }],
        metrics: ["count"],
        max_output_rows: 1
      },
      fakeClient as never
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.details?.candidate_plan).toEqual(expect.objectContaining({ batches: [1] }));
  });

  it("rejects unknown group, metric, and segment filter fields before scanning", async () => {
    const fakeClient = {
      async invoke() {
        throw new Error("should not scan");
      }
    };

    const result = await analyzePrivateResidentialSales(
      {
        projects: ["NORMANTON PARK"],
        group_by: ["project_typo"],
        metrics: ["price_typo_median"],
        segments: [{ name: "bedrooms", filters: { bedrooms_gte: 3 } }]
      },
      fakeClient as never
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.details?.validation_errors).toEqual(
      expect.arrayContaining([
        "Unknown group_by field 'project_typo'.",
        "Unknown metric field 'price_typo' in 'price_typo_median'.",
        "Unknown filter field 'bedrooms'."
      ])
    );
  });
});

function projectPayload(project: string, street: string, marketSegment: string, district: string, area: number, basePrice: number) {
  const months = ["0125", "0425", "0725", "1025", "0126", "0426"];
  return {
    project,
    street,
    marketSegment,
    transaction: months.map((contractDate, index) => ({
      contractDate,
      area: String(area),
      price: String(basePrice + index * 10_000),
      propertyType: "Condominium",
      typeOfArea: "Strata",
      tenure: "99 yrs",
      floorRange: "06-10",
      typeOfSale: "3",
      district,
      noOfUnits: "1"
    }))
  };
}
