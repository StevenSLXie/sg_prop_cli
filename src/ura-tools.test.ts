import { describe, expect, it } from "vitest";
import { UraClient } from "./ura-client.js";
import { findPrivateResidentialRentalContracts, findPrivateResidentialSaleComparables } from "./ura-tools.js";

describe("URA private sale tool", () => {
  it("returns compact sale rows and summary without raw by default", async () => {
    const fakeClient = {
      async invoke() {
        return {
          Status: "Success",
          Result: [
            {
              project: "TURQUOISE",
              street: "COVE DRIVE",
              marketSegment: "CCR",
              x: "1",
              y: "2",
              transaction: [
                {
                  contractDate: "0126",
                  area: "100",
                  price: "2000000",
                  propertyType: "Condominium",
                  typeOfArea: "Strata",
                  tenure: "99 yrs",
                  floorRange: "01-05",
                  typeOfSale: "3",
                  district: "04",
                  noOfUnits: "1"
                }
              ]
            }
          ]
        };
      }
    };

    const result = await findPrivateResidentialSaleComparables(
      { project: "turquoise", district: "04", type_of_sale: "resale", limit: 5 },
      fakeClient as never
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows?.[0]?.project).toBe("TURQUOISE");
    expect(result.data.rows?.[0]?.raw).toBeUndefined();
    expect(result.data.summary?.sample_size).toBe(1);
    expect(result.data.summary?.by_type_of_sale).toEqual({ resale: 1 });
  });

  it("rejects include_raw with large limit", async () => {
    const result = await findPrivateResidentialSaleComparables({ include_raw: true, limit: 51 }, {} as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects selecting raw directly", async () => {
    const result = await findPrivateResidentialSaleComparables({ select: ["raw"], limit: 5 }, {} as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("URA private rental tool", () => {
  it("uses every requested quarter in a from-to range", async () => {
    const refPeriods: unknown[] = [];
    const fakeClient = {
      async invoke(_service: string, params: Record<string, unknown>) {
        refPeriods.push(params.refPeriod);
        return { Status: "Success", Result: [] };
      }
    };
    const result = await findPrivateResidentialRentalContracts({ from: "2024-Q1", to: "2024-Q2" }, fakeClient as never);
    expect(result.ok).toBe(true);
    expect(refPeriods).toEqual(["24q1", "24q2"]);
  });
});

describe("URA client proxy routing", () => {
  it("uses the maintained default proxy instead of direct URA token endpoints", async () => {
    const oldFetch = globalThis.fetch;
    const oldKey = process.env.URA_ACCESS_KEY;
    const oldBroker = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    const calls: string[] = [];
    const bodies: unknown[] = [];
    process.env.URA_ACCESS_KEY = "test-key";
    delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ Status: "Success", Result: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new UraClient();
    const result = await client.invoke("PMI_Resi_Transaction", { batch: 1 });
    expect(result).toEqual({ Status: "Success", Result: [] });
    expect(calls).toEqual(["https://sg-housing-data-mcp-spec.vercel.app/api/ura"]);
    expect(calls.some((call) => call.includes("insertNewToken") || call.includes("invokeUraDS"))).toBe(false);
    expect(bodies).toEqual([{ service: "PMI_Resi_Transaction", params: { batch: 1 } }]);

    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.URA_ACCESS_KEY;
    else process.env.URA_ACCESS_KEY = oldKey;
    if (oldBroker === undefined) delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    else process.env.SG_HOUSING_URA_TOKEN_BROKER_URL = oldBroker;
  });

  it("allows maintainers to override the proxy URL explicitly", async () => {
    const oldFetch = globalThis.fetch;
    const oldBroker = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    const calls: string[] = [];
    process.env.SG_HOUSING_URA_TOKEN_BROKER_URL = "https://example.test/ura";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({ Status: "Success", Result: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new UraClient();
    await expect(client.invoke("PMI_Resi_Transaction", { batch: 1 })).resolves.toEqual({ Status: "Success", Result: [] });
    expect(calls).toEqual(["https://example.test/ura"]);

    globalThis.fetch = oldFetch;
    if (oldBroker === undefined) delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    else process.env.SG_HOUSING_URA_TOKEN_BROKER_URL = oldBroker;
  });
});
