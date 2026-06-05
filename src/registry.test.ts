import { describe, expect, it } from "vitest";
import { getDistributionMode } from "./credentials.js";
import { getSource, listSources, SOURCES } from "./registry.js";

describe("registry", () => {
  it("does not include fields in source listing by default", () => {
    const [first] = listSources();
    expect(first).toBeDefined();
    expect(first.fields).toBeUndefined();
  });

  it("rejects all-source field catalog dumps", () => {
    expect(() => listSources({ includeFields: true })).toThrow(/narrow category or sourceKeys/);
  });

  it("has dataset ids for public data.gov.sg URA summary sources", () => {
    const summaryKeys = [
      "ura_non_landed_rental_benchmark",
      "ura_private_transaction_volume",
      "ura_private_price_index",
      "ura_private_rental_index"
    ] as const;
    for (const key of summaryKeys) {
      const source = getSource(key);
      expect(source?.backend).toBe("data_gov_sg");
      expect(source?.dataset_ids?.length).toBeGreaterThan(0);
    }
  });

  it("uses stable unique source keys", () => {
    const keys = SOURCES.map((source) => source.source_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("credentials", () => {
  it("does not treat URA_ACCESS_KEY alone as maintained distribution", () => {
    const oldKey = process.env.URA_ACCESS_KEY;
    const oldBroker = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    const oldMode = process.env.SG_HOUSING_DISTRIBUTION_MODE;
    process.env.URA_ACCESS_KEY = "test";
    delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    delete process.env.SG_HOUSING_DISTRIBUTION_MODE;
    expect(getDistributionMode()).not.toBe("maintained");
    if (oldKey === undefined) delete process.env.URA_ACCESS_KEY;
    else process.env.URA_ACCESS_KEY = oldKey;
    if (oldBroker === undefined) delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    else process.env.SG_HOUSING_URA_TOKEN_BROKER_URL = oldBroker;
    if (oldMode === undefined) delete process.env.SG_HOUSING_DISTRIBUTION_MODE;
    else process.env.SG_HOUSING_DISTRIBUTION_MODE = oldMode;
  });
});
