import type { DistributionMode } from "./types.js";

const DEFAULT_URA_TOKEN_BROKER_URL = "https://sg-housing-data-mcp-spec.vercel.app/api/ura";

export type CredentialStrategy =
  | { kind: "env_access_key"; accessKey: string }
  | { kind: "token_broker"; brokerUrl: string }
  | { kind: "unavailable" };

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

export function getCredentialStrategy(): CredentialStrategy {
  const accessKey = process.env.URA_ACCESS_KEY;
  if (accessKey && accessKey.trim()) {
    return { kind: "env_access_key", accessKey: accessKey.trim() };
  }

  const brokerUrl = process.env.SG_HOUSING_URA_TOKEN_BROKER_URL;
  if (brokerUrl && brokerUrl.trim()) {
    return { kind: "token_broker", brokerUrl: brokerUrl.trim() };
  }

  if (DEFAULT_URA_TOKEN_BROKER_URL) {
    return { kind: "token_broker", brokerUrl: DEFAULT_URA_TOKEN_BROKER_URL };
  }

  return { kind: "unavailable" };
}

export function redactSecret(value: string): string {
  if (value.length <= 8) return "<redacted>";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
