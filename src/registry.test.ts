import { describe, expect, it } from "vitest";
import { getCredentialStrategy, getDataGovStrategy, getDistributionMode } from "./credentials.js";
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
  it("uses the maintained default proxy when no explicit credential override is set", () => {
    const oldKey = process.env.URA_ACCESS_KEY;
    const oldBroker = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    const oldMode = process.env.SG_HOUSING_DISTRIBUTION_MODE;
    const oldDataGovDirect = process.env.SG_HOUSING_DATA_GOV_DIRECT;
    const oldDataGovKey = process.env.DATA_GOV_SG_API_KEY;
    const oldDataGovProxy = process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
    delete process.env.URA_ACCESS_KEY;
    delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    delete process.env.SG_HOUSING_DISTRIBUTION_MODE;
    delete process.env.SG_HOUSING_DATA_GOV_DIRECT;
    delete process.env.DATA_GOV_SG_API_KEY;
    delete process.env.SG_HOUSING_DATA_GOV_PROXY_URL;

    expect(getDistributionMode()).toBe("maintained");
    expect(getCredentialStrategy().kind).toBe("token_broker");
    expect(getDataGovStrategy().kind).toBe("proxy");

    restoreCredentialsEnv(oldKey, oldBroker, oldMode, oldDataGovDirect, oldDataGovKey, oldDataGovProxy);
  });

  it("uses the maintained default proxy even when URA_ACCESS_KEY is present locally", () => {
    const oldKey = process.env.URA_ACCESS_KEY;
    const oldBroker = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    const oldMode = process.env.SG_HOUSING_DISTRIBUTION_MODE;
    const oldDataGovDirect = process.env.SG_HOUSING_DATA_GOV_DIRECT;
    const oldDataGovKey = process.env.DATA_GOV_SG_API_KEY;
    const oldDataGovProxy = process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
    process.env.URA_ACCESS_KEY = "test";
    delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    delete process.env.SG_HOUSING_DISTRIBUTION_MODE;
    delete process.env.SG_HOUSING_DATA_GOV_DIRECT;
    delete process.env.DATA_GOV_SG_API_KEY;
    delete process.env.SG_HOUSING_DATA_GOV_PROXY_URL;

    expect(getDistributionMode()).toBe("maintained");
    expect(getCredentialStrategy().kind).toBe("token_broker");
    expect(getDataGovStrategy().kind).toBe("proxy");

    restoreCredentialsEnv(oldKey, oldBroker, oldMode, oldDataGovDirect, oldDataGovKey, oldDataGovProxy);
  });

  it("allows direct data.gov.sg API key mode for development", () => {
    const oldKey = process.env.URA_ACCESS_KEY;
    const oldBroker = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
    const oldMode = process.env.SG_HOUSING_DISTRIBUTION_MODE;
    const oldDataGovDirect = process.env.SG_HOUSING_DATA_GOV_DIRECT;
    const oldDataGovKey = process.env.DATA_GOV_SG_API_KEY;
    const oldDataGovProxy = process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
    process.env.SG_HOUSING_DATA_GOV_DIRECT = "1";
    process.env.DATA_GOV_SG_API_KEY = "data-gov-key";
    delete process.env.SG_HOUSING_DATA_GOV_PROXY_URL;

    expect(getDataGovStrategy()).toEqual({ kind: "direct_with_key", apiKey: "data-gov-key" });

    restoreCredentialsEnv(oldKey, oldBroker, oldMode, oldDataGovDirect, oldDataGovKey, oldDataGovProxy);
  });
});

function restoreCredentialsEnv(
  oldKey: string | undefined,
  oldBroker: string | undefined,
  oldMode: string | undefined,
  oldDataGovDirect: string | undefined,
  oldDataGovKey: string | undefined,
  oldDataGovProxy: string | undefined
): void {
  if (oldKey === undefined) delete process.env.URA_ACCESS_KEY;
  else process.env.URA_ACCESS_KEY = oldKey;
  if (oldBroker === undefined) delete process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
  else process.env.SG_HOUSING_URA_TOKEN_BROKER_URL = oldBroker;
  if (oldMode === undefined) delete process.env.SG_HOUSING_DISTRIBUTION_MODE;
  else process.env.SG_HOUSING_DISTRIBUTION_MODE = oldMode;
  if (oldDataGovDirect === undefined) delete process.env.SG_HOUSING_DATA_GOV_DIRECT;
  else process.env.SG_HOUSING_DATA_GOV_DIRECT = oldDataGovDirect;
  if (oldDataGovKey === undefined) delete process.env.DATA_GOV_SG_API_KEY;
  else process.env.DATA_GOV_SG_API_KEY = oldDataGovKey;
  if (oldDataGovProxy === undefined) delete process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
  else process.env.SG_HOUSING_DATA_GOV_PROXY_URL = oldDataGovProxy;
}
