const DATASTORE_SEARCH_URL = "https://data.gov.sg/api/action/datastore_search";
const MAX_LIMIT = 500;
const MAX_FILTER_BYTES = 4096;
const HEALTH_RESOURCE_ID = "d_b51323a474ba789fb4cc3db58a3116d4";
const HEALTH_TTL_MS = 60_000;

let healthCache: { checkedAt: number; payload: HealthPayload } | null = null;

const ALLOWED_RESOURCE_IDS = new Set([
  "d_8b84c4ee58e3cfc0ece0d773c8ca6abc",
  "d_43f493c6c50d54243cc1eab0df142d6a",
  "d_2d5ff9ea31397b66239f245f57751537",
  "d_ebc5ab87086db484f88045b47411ebc5",
  "d_ea9ed51da2787afaf8e51f827c304208",
  "d_c9f57187485a850908655db0e8cfe651",
  "d_b51323a474ba789fb4cc3db58a3116d4",
  "d_23000a00c52996c55106084ed0339566",
  "d_17f5382f26140b1fdae0ba2ef6239d2f",
  "d_07c63be0f37e6e59c07a4ddc2fd87fcb",
  "d_ee7e46d3c57f7865790704632b0aef71",
  "d_149ac00a2734bb0a03867bbe2ec0e7b0",
  "d_7c69c943d5f0d89d6a9a773d2b51f337",
  "d_97f8a2e995022d311c6c68cfda6d034c",
  "d_8e4c50283fb7052a391dfb746a05c853"
]);

export default async function handler(request: any, response: any) {
  response.setHeader("cache-control", "s-maxage=30, stale-while-revalidate=120");

  if (request.method === "GET") {
    const health = await healthPayload();
    response.status(200).json({
      ok: true,
      service: "sg-housing-data-gov-proxy",
      ...health,
      allowed_resource_count: ALLOWED_RESOURCE_IDS.size
    });
    return;
  }

  if (request.method === "OPTIONS") {
    response.setHeader("allow", "GET,POST,OPTIONS");
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("allow", "GET,POST,OPTIONS");
    response.status(405).json({ success: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } });
    return;
  }

  try {
    const params = validateBody(parseBody(request.body));
    const payload = await invokeDatastore(params);
    response.status(200).json(payload);
  } catch (error) {
    const mapped = mapError(error);
    response.status(mapped.status).json({ success: false, error: { code: mapped.code, message: mapped.message } });
  }
}

async function healthPayload(): Promise<HealthPayload> {
  const configured = Boolean(getApiKey());
  const now = Date.now();
  if (healthCache && now - healthCache.checkedAt < HEALTH_TTL_MS) return healthCache.payload;
  try {
    await invokeDatastore({ resource_id: HEALTH_RESOURCE_ID, limit: 1, offset: 0 });
    const payload = { configured, upstream_ok: true };
    healthCache = { checkedAt: now, payload };
    return payload;
  } catch (error) {
    const payload = {
      configured,
      upstream_ok: false,
      upstream_error: error instanceof Error ? error.message : String(error)
    };
    healthCache = { checkedAt: now, payload };
    return payload;
  }
}

async function invokeDatastore(params: ProxyDatastoreParams): Promise<unknown> {
  const url = new URL(DATASTORE_SEARCH_URL);
  url.searchParams.set("resource_id", params.resource_id);
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("offset", String(params.offset));
  if (params.filters && Object.keys(params.filters).length > 0) {
    url.searchParams.set("filters", JSON.stringify(params.filters));
  }
  if (params.sort) {
    url.searchParams.set("sort", params.sort);
  }

  const headers: Record<string, string> = { accept: "application/json" };
  const apiKey = getApiKey();
  if (apiKey) headers["x-api-key"] = apiKey;

  const upstream = await fetchWithRetry(url, { headers }, 15000);
  if (upstream.status === 429) throw new ProxyError("DATA_GOV_RATE_LIMITED", "data.gov.sg rate limit exceeded.");
  if (!upstream.ok) throw new ProxyError("DATA_GOV_UNAVAILABLE", `data.gov.sg returned HTTP ${upstream.status}.`);
  const payload = await upstream.json();
  if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).success !== true) {
    throw new ProxyError("DATA_GOV_UNAVAILABLE", "data.gov.sg returned an unsuccessful payload.");
  }
  return payload;
}

function validateBody(body: Record<string, unknown>): ProxyDatastoreParams {
  const resourceId = String(body.resource_id ?? "");
  if (!ALLOWED_RESOURCE_IDS.has(resourceId)) {
    throw new ProxyError("VALIDATION_ERROR", "resource_id is not exposed by this proxy.");
  }

  const limit = Number(body.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ProxyError("VALIDATION_ERROR", `limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }

  const offset = Number(body.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ProxyError("VALIDATION_ERROR", "offset must be a non-negative integer.");
  }

  const filters = validateFilters(body.filters);
  const sort = validateSort(body.sort);
  return { resource_id: resourceId, limit, offset, filters, sort };
}

function validateFilters(value: unknown): Record<string, string | number | Array<string | number>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProxyError("VALIDATION_ERROR", "filters must be an object.");
  }
  const json = JSON.stringify(value);
  if (json.length > MAX_FILTER_BYTES) {
    throw new ProxyError("VALIDATION_ERROR", "filters payload is too large.");
  }
  const filters: Record<string, string | number | Array<string | number>> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new ProxyError("VALIDATION_ERROR", "filter field contains unsupported characters.");
    if (typeof rawValue === "string" || typeof rawValue === "number") {
      filters[key] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue) && rawValue.every((item) => typeof item === "string" || typeof item === "number")) {
      filters[key] = rawValue;
      continue;
    }
    throw new ProxyError("VALIDATION_ERROR", "filter values must be strings, numbers, or arrays of strings/numbers.");
  }
  return filters;
}

function validateSort(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ProxyError("VALIDATION_ERROR", "sort must be a string.");
  if (!/^[A-Za-z0-9_]+ (asc|desc)$/i.test(value)) {
    throw new ProxyError("VALIDATION_ERROR", "sort must look like 'field asc' or 'field desc'.");
  }
  return value;
}

async function fetchWithRetry(input: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProxyError("DATA_GOV_UNAVAILABLE", `data.gov.sg network request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function getApiKey(): string | null {
  const apiKey = process.env.DATA_GOV_SG_API_KEY;
  return apiKey && apiKey.trim() ? apiKey.trim() : null;
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof SyntaxError) return { status: 400, code: "INVALID_JSON", message: "Request body must be valid JSON." };
  if (error instanceof ProxyError) {
    return {
      status: error.code === "VALIDATION_ERROR" ? 400 : error.code === "DATA_GOV_RATE_LIMITED" ? 429 : 503,
      code: error.code,
      message: error.message
    };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

type ProxyDatastoreParams = {
  resource_id: string;
  limit: number;
  offset: number;
  filters?: Record<string, string | number | Array<string | number>>;
  sort?: string;
};

type HealthPayload = {
  configured: boolean;
  upstream_ok: boolean;
  upstream_error?: string;
};

class ProxyError extends Error {
  constructor(
    public readonly code: "VALIDATION_ERROR" | "DATA_GOV_RATE_LIMITED" | "DATA_GOV_UNAVAILABLE",
    message: string
  ) {
    super(message);
  }
}
