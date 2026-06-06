import type { DistributionMode } from "./types.js";

const DEFAULT_URA_TOKEN_BROKER_URL = "https://sg-housing-data-mcp-spec.vercel.app/api/ura";
const DEFAULT_DATA_GOV_PROXY_URL = "https://sg-housing-data-mcp-spec.vercel.app/api/data-gov";

export type CredentialStrategy =
  | { kind: "env_access_key"; accessKey: string }
  | { kind: "token_broker"; brokerUrl: string }
  | { kind: "unavailable" };

export type DataGovStrategy =
  | { kind: "proxy"; proxyUrl: string }
  | { kind: "direct_with_key"; apiKey: string }
  | { kind: "public_direct" };

export function getDistributionMode(): DistributionMode {
  const override = process.env.SG_HOUSING_DISTRIBUTION_MODE;
  if (override === "public" || override === "maintained" || override === "development") {
    return override;
  }
  if (process.env.SG_HOUSING_URA_TOKEN_BROKER_URL) {
    return "maintained";
  }
  if (DEFAULT_URA_TOKEN_BROKER_URL) {
    return "maintained";
  }
  return process.env.NODE_ENV === "development" ? "development" : "public";
}

export function getDataGovStrategy(): DataGovStrategy {
  const proxyUrl = process.env.SG_HOUSING_DATA_GOV_PROXY_URL;
  if (proxyUrl && proxyUrl.trim()) {
    return { kind: "proxy", proxyUrl: proxyUrl.trim() };
  }

  if (process.env.SG_HOUSING_DATA_GOV_DIRECT === "1") {
    const apiKey = process.env.DATA_GOV_SG_API_KEY;
    if (apiKey && apiKey.trim()) return { kind: "direct_with_key", apiKey: apiKey.trim() };
    return { kind: "public_direct" };
  }

  if (DEFAULT_DATA_GOV_PROXY_URL) {
    return { kind: "proxy", proxyUrl: DEFAULT_DATA_GOV_PROXY_URL };
  }

  const apiKey = process.env.DATA_GOV_SG_API_KEY;
  if (apiKey && apiKey.trim()) return { kind: "direct_with_key", apiKey: apiKey.trim() };
  return { kind: "public_direct" };
}

export function getCredentialStrategy(): CredentialStrategy {
  const brokerUrl = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
  if (brokerUrl && brokerUrl.trim()) {
    return { kind: "token_broker", brokerUrl: brokerUrl.trim() };
  }

  if (DEFAULT_URA_TOKEN_BROKER_URL) {
    return { kind: "token_broker", brokerUrl: DEFAULT_URA_TOKEN_BROKER_URL };
  }

  const accessKey = process.env.URA_ACCESS_KEY;
  if (accessKey && accessKey.trim()) {
    return { kind: "env_access_key", accessKey: accessKey.trim() };
  }

  return { kind: "unavailable" };
}

export function redactSecret(value: string): string {
  if (value.length <= 8) return "<redacted>";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
