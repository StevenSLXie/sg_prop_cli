import { describe, expect, it } from "vitest";
import { AnalysisEngineError, analyzeRows } from "./analysis-engine.js";

const rows = [
  { project: "A", quarter: "2026-Q1", price: 100, price_psf: 1000, area_sqm: 50 },
  { project: "A", quarter: "2026-Q1", price: 200, price_psf: 1200, area_sqm: 90 },
  { project: "A", quarter: "2026-Q1", price: 300, price_psf: 1400, area_sqm: 100 },
  { project: "B", quarter: "2026-Q1", price: 400, price_psf: 1600, area_sqm: 110 }
];

describe("analysis engine", () => {
  it("materializes long-table count and numeric summaries by group and segment", () => {
    const result = analyzeRows({
      rows,
      groupBy: ["project", "quarter"],
      segments: [
        { name: "all" },
        { name: "large", matches: (row) => Number(row.area_sqm) >= 85 }
      ],
      metrics: ["count", "price_median", "price_p25", "price_p75", "price_psf_avg", "area_sqm_median"],
      output: "long_table",
      maxOutputRows: 20,
      maxOutputColumns: 20
    });

    expect(result.columns).toEqual(["project", "quarter", "segment", "count", "price_median", "price_p25", "price_p75", "price_psf_avg", "area_sqm_median"]);
    expect(result.rows).toEqual([
      {
        project: "A",
        quarter: "2026-Q1",
        segment: "all",
        count: 3,
        price_median: 200,
        price_p25: 150,
        price_p75: 250,
        price_psf_avg: 1200,
        area_sqm_median: 90
      },
      {
        project: "A",
        quarter: "2026-Q1",
        segment: "large",
        count: 2,
        price_median: 250,
        price_p25: 225,
        price_p75: 275,
        price_psf_avg: 1300,
        area_sqm_median: 95
      },
      {
        project: "B",
        quarter: "2026-Q1",
        segment: "all",
        count: 1,
        price_median: 400,
        price_p25: 400,
        price_p75: 400,
        price_psf_avg: 1600,
        area_sqm_median: 110
      },
      {
        project: "B",
        quarter: "2026-Q1",
        segment: "large",
        count: 1,
        price_median: 400,
        price_p25: 400,
        price_p75: 400,
        price_psf_avg: 1600,
        area_sqm_median: 110
      }
    ]);
  });

  it("omits empty segment groups from long output", () => {
    const result = analyzeRows({
      rows,
      groupBy: ["project"],
      segments: [{ name: "penthouse", matches: (row) => Number(row.area_sqm) > 500 }],
      metrics: ["count", "price_median"],
      output: "long_table",
      maxOutputRows: 20,
      maxOutputColumns: 20
    });

    expect(result.rows).toEqual([]);
  });

  it("materializes wide-table output with stable segment metric columns", () => {
    const result = analyzeRows({
      rows,
      groupBy: ["project"],
      segments: [
        { name: "all" },
        { name: "large units", matches: (row) => Number(row.area_sqm) >= 85 }
      ],
      metrics: ["count", "price_median"],
      output: "wide_table",
      maxOutputRows: 20,
      maxOutputColumns: 20
    });

    expect(result.columns).toEqual(["project", "all_count", "all_price_median", "large_units_count", "large_units_price_median"]);
    expect(result.rows).toEqual([
      { project: "A", all_count: 3, all_price_median: 200, large_units_count: 2, large_units_price_median: 250 },
      { project: "B", all_count: 1, all_price_median: 400, large_units_count: 1, large_units_price_median: 400 }
    ]);
  });

  it("enforces the output row cap", () => {
    expect(() =>
      analyzeRows({
        rows,
        groupBy: ["project"],
        segments: [{ name: "all" }],
        metrics: ["count"],
        output: "long_table",
        maxOutputRows: 1,
        maxOutputColumns: 20
      })
    ).toThrow(AnalysisEngineError);
  });

  it("enforces the output column cap", () => {
    expect(() =>
      analyzeRows({
        rows,
        groupBy: ["project"],
        segments: [
          { name: "all" },
          { name: "large" }
        ],
        metrics: ["count", "price_median"],
        output: "wide_table",
        maxOutputRows: 20,
        maxOutputColumns: 4
      })
    ).toThrow(AnalysisEngineError);
  });

  it("rejects duplicate segment names and unknown metrics", () => {
    expect(() =>
      analyzeRows({
        rows,
        groupBy: ["project"],
        segments: [
          { name: "all" },
          { name: "all" }
        ],
        metrics: ["count"],
        output: "long_table",
        maxOutputRows: 20,
        maxOutputColumns: 20
      })
    ).toThrow("Duplicate segment name");

    expect(() =>
      analyzeRows({
        rows,
        groupBy: ["project"],
        segments: [{ name: "all" }],
        metrics: ["price_mode"],
        output: "long_table",
        maxOutputRows: 20,
        maxOutputColumns: 20
      })
    ).toThrow("Unsupported analysis metric");
  });
});
