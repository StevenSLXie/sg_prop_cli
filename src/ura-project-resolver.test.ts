import { describe, expect, it } from "vitest";
import { districtToBatch, normalizeUraLookupKey, resolveUraSaleCandidatePlan } from "./ura-project-resolver.js";

describe("URA project resolver", () => {
  it("maps district ranges to URA transaction batches", () => {
    expect(districtToBatch("01")).toBe(1);
    expect(districtToBatch("07")).toBe(1);
    expect(districtToBatch("08")).toBe(2);
    expect(districtToBatch("14")).toBe(2);
    expect(districtToBatch("15")).toBe(3);
    expect(districtToBatch("21")).toBe(3);
    expect(districtToBatch("22")).toBe(4);
    expect(districtToBatch("28")).toBe(4);
    expect(districtToBatch("29")).toBeNull();
  });

  it("normalizes punctuation and whitespace for project lookups", () => {
    expect(normalizeUraLookupKey(" D'Leedon ")).toBe("D LEEDON");
    expect(normalizeUraLookupKey("Parc   Esta")).toBe("PARC ESTA");
    expect(normalizeUraLookupKey("A & B")).toBe("A AND B");
  });

  it("resolves the target projects without using all-batch discovery scans", () => {
    const plan = resolveUraSaleCandidatePlan({
      projects: ["Parc Riviera", "Normanton Park", "Parc Esta", "D'Leedon", "Sims Urban Oasis"]
    });

    expect(plan.batches).toEqual([1, 2]);
    expect(plan.broad_scan_reason).toBeUndefined();
    expect(plan.unresolved_inputs).toEqual([]);
    expect(plan.resolved_projects).toEqual([
      expect.objectContaining({ input: "Parc Riviera", matched_project: "PARC RIVIERA", batch: 1 }),
      expect.objectContaining({ input: "Normanton Park", matched_project: "NORMANTON PARK", batch: 1 }),
      expect.objectContaining({ input: "Parc Esta", matched_project: "PARC ESTA", batch: 2 }),
      expect.objectContaining({ input: "D'Leedon", matched_project: "D'LEEDON", batch: 2 }),
      expect.objectContaining({ input: "Sims Urban Oasis", matched_project: "SIMS URBAN OASIS", batch: 2 })
    ]);
  });

  it("resolves street filters and intersects them with district filters", () => {
    const plan = resolveUraSaleCandidatePlan({
      streets: ["West Coast Vale", "Sims Avenue"],
      districts: ["05", "14"]
    });

    expect(plan.batches).toEqual([1, 2]);
    expect(plan.broad_scan_reason).toBeUndefined();
    expect(plan.resolved_projects).toEqual([
      expect.objectContaining({ input: "West Coast Vale", matched_project: "PARC RIVIERA", batch: 1 }),
      expect.objectContaining({ input: "Sims Avenue", matched_project: "PARC ESTA", batch: 2 })
    ]);
  });

  it("narrows project candidates by district batch intersection", () => {
    const plan = resolveUraSaleCandidatePlan({
      projects: ["Parc Esta", "Normanton Park"],
      districts: ["14"]
    });

    expect(plan.batches).toEqual([2]);
    expect(plan.broad_scan_reason).toBeUndefined();
  });

  it("reports unresolved inputs and falls back to an explicit broad scan", () => {
    const plan = resolveUraSaleCandidatePlan({ projects: ["Unknown Project"] });

    expect(plan.batches).toEqual([1, 2, 3, 4]);
    expect(plan.unresolved_inputs).toEqual(["Unknown Project"]);
    expect(plan.broad_scan_reason).toContain("could not be resolved");
    expect(plan.resolved_projects).toEqual([expect.objectContaining({ input: "Unknown Project", confidence: "unresolved" })]);
  });

  it("reports ambiguous inputs without pretending exact project precision", () => {
    const plan = resolveUraSaleCandidatePlan({
      projects: ["Parc"],
      index: [
        { project: "PARC A", street: "A STREET", district: "05" },
        { project: "PARC B", street: "B STREET", district: "14" }
      ]
    });

    expect(plan.batches).toEqual([1, 2]);
    expect(plan.broad_scan_reason).toBeUndefined();
    expect(plan.resolved_projects).toEqual([
      expect.objectContaining({
        input: "Parc",
        matched_project: "PARC A | PARC B",
        confidence: "ambiguous"
      })
    ]);
  });
});
