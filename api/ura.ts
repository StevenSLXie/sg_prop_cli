const TOKEN_URL = "https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1";
const INVOKE_URL = "https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1";

const ALLOWED_SERVICES: Record<string, (params: unknown) => Record<string, string | number>> = {
  PMI_Resi_Transaction: validateTransactionParams,
  PMI_Resi_Rental: validateRentalParams,
  PMI_Resi_Rental_Median: validateNoParams,
  PMI_Resi_Developer_Sales: validateNoParams
};

let token: string | null = null;
let tokenDate: string | null = null;
let refreshPromise: Promise<string> | null = null;

export default async function handler(request: any, response: any) {
  response.setHeader("cache-control", "no-store");

  if (request.method === "GET") {
    response.status(200).json({
      ok: true,
      service: "sg-housing-ura-proxy",
      configured: Boolean(getAccessKey()),
      allowed_services: Object.keys(ALLOWED_SERVICES)
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
    response.status(405).json({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } });
    return;
  }

  try {
    const accessKey = requireAccessKey();
    const body = parseBody(request.body);
    const service = body.service;
    if (typeof service !== "string" || !(service in ALLOWED_SERVICES)) {
      response.status(400).json({
        ok: false,
        error: {
          code: "SERVICE_NOT_ALLOWED",
          message: "Requested URA service is not exposed by this proxy.",
          allowed_services: Object.keys(ALLOWED_SERVICES)
        }
      });
      return;
    }

    const params = ALLOWED_SERVICES[service](body.params);
    const payload = await invokeUra(accessKey, service, params);
    response.status(200).json(payload);
  } catch (error) {
    const mapped = mapError(error);
    response.status(mapped.status).json({ ok: false, Status: "Error", Message: mapped.message, error: { code: mapped.code, message: mapped.message } });
  }
}

async function invokeUra(accessKey: string, service: string, params: Record<string, string | number>): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const currentToken = await getToken(accessKey);
    const url = new URL(INVOKE_URL);
    url.searchParams.set("service", service);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const upstream = await fetchWithRetry(url, { headers: { accept: "application/json", AccessKey: accessKey, Token: currentToken } }, 25000);

    try {
      return await parseUraResponse(upstream);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProxyError) || error.code !== "URA_AUTH_FAILED" || attempt === 1) throw error;
      token = null;
      tokenDate = null;
    }
  }
  throw lastError instanceof Error ? lastError : new ProxyError("URA_SERVICE_UNAVAILABLE", "URA request failed.");
}

async function getToken(accessKey: string): Promise<string> {
  const today = singaporeDate();
  if (token && tokenDate === today) return token;
  if (refreshPromise) return refreshPromise;

  refreshPromise = fetchToken(accessKey, today).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function fetchToken(accessKey: string, today: string): Promise<string> {
  const upstream = await fetchWithRetry(TOKEN_URL, { headers: { accept: "application/json", AccessKey: accessKey } }, 15000);
  const payload = await parseUraResponse(upstream);
  const result = payload && typeof payload === "object" ? (payload as Record<string, unknown>).Result : null;
  if (typeof result !== "string" || !result) {
    throw new ProxyError("URA_SERVICE_UNAVAILABLE", "URA token response did not include Result.");
  }
  token = result;
  tokenDate = today;
  return result;
}

async function parseUraResponse(upstream: Response): Promise<unknown> {
  if (upstream.status === 429) throw new ProxyError("URA_RATE_LIMITED", "URA rate limit exceeded.");
  if (upstream.status === 401 || upstream.status === 403) throw new ProxyError("URA_AUTH_FAILED", "URA authentication failed.");
  if (!upstream.ok) throw new ProxyError("URA_SERVICE_UNAVAILABLE", `URA returned HTTP ${upstream.status}.`);

  const payload = (await upstream.json()) as Record<string, unknown>;
  const status = String(payload.Status ?? payload.status ?? "Success").toLowerCase();
  const message = String(payload.Message ?? payload.message ?? "");
  if (status && status !== "success") {
    if (/auth|token|access|key/i.test(message)) throw new ProxyError("URA_AUTH_FAILED", "URA authentication failed.");
    throw new ProxyError("URA_SERVICE_UNAVAILABLE", message || "URA returned unsuccessful status.");
  }
  return payload;
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
  throw new ProxyError("URA_SERVICE_UNAVAILABLE", `URA network request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function validateTransactionParams(params: unknown): Record<string, number> {
  const record = objectParams(params);
  const batch = Number(record.batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > 4) {
    throw new ProxyError("VALIDATION_ERROR", "PMI_Resi_Transaction requires integer batch 1..4.");
  }
  return { batch };
}

function validateRentalParams(params: unknown): Record<string, string> {
  const record = objectParams(params);
  const refPeriod = String(record.refPeriod ?? "");
  if (!/^\d{2}q[1-4]$/i.test(refPeriod)) {
    throw new ProxyError("VALIDATION_ERROR", "PMI_Resi_Rental requires refPeriod in YYqN format, for example 26q1.");
  }
  return { refPeriod: refPeriod.toLowerCase() };
}

function validateNoParams(params: unknown): Record<string, never> {
  const record = objectParams(params);
  const keys = Object.keys(record);
  if (keys.length > 0) {
    throw new ProxyError("VALIDATION_ERROR", "This URA service does not accept proxy parameters.");
  }
  return {};
}

function objectParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new ProxyError("VALIDATION_ERROR", "params must be an object.");
  }
  return params as Record<string, unknown>;
}

function parseBody(body: unknown): { service?: unknown; params?: unknown } {
  if (typeof body === "string") return JSON.parse(body) as { service?: unknown; params?: unknown };
  if (body && typeof body === "object") return body as { service?: unknown; params?: unknown };
  return {};
}

function requireAccessKey(): string {
  const accessKey = getAccessKey();
  if (!accessKey) throw new ProxyError("PROXY_NOT_CONFIGURED", "URA_ACCESS_KEY is not configured on the proxy.");
  return accessKey;
}

function getAccessKey(): string | null {
  const accessKey = process.env.URA_ACCESS_KEY;
  return accessKey && accessKey.trim() ? accessKey.trim() : null;
}

function singaporeDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof SyntaxError) return { status: 400, code: "INVALID_JSON", message: "Request body must be valid JSON." };
  if (error instanceof ProxyError) {
    const status =
      error.code === "VALIDATION_ERROR" || error.code === "SERVICE_NOT_ALLOWED"
        ? 400
        : error.code === "PROXY_NOT_CONFIGURED"
          ? 503
          : error.code === "URA_RATE_LIMITED"
            ? 429
            : error.code === "URA_AUTH_FAILED"
              ? 502
              : 503;
    return { status, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|network|timeout|aborted/i.test(message)) {
    return { status: 503, code: "URA_SERVICE_UNAVAILABLE", message: `URA network request failed: ${message}` };
  }
  return { status: 500, code: "INTERNAL_ERROR", message };
}

class ProxyError extends Error {
  constructor(
    public readonly code:
      | "VALIDATION_ERROR"
      | "SERVICE_NOT_ALLOWED"
      | "PROXY_NOT_CONFIGURED"
      | "URA_AUTH_FAILED"
      | "URA_RATE_LIMITED"
      | "URA_SERVICE_UNAVAILABLE",
    message: string
  ) {
    super(message);
  }
}
