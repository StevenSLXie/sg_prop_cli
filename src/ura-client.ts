import { getCredentialStrategy, redactSecret } from "./credentials.js";

const TOKEN_URL = "https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1";
const INVOKE_URL = "https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1";

export class UraClient {
  private token: string | null = null;
  private tokenDate: string | null = null;
  private refreshPromise: Promise<string> | null = null;

  async invoke(service: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const strategy = getCredentialStrategy();
    if (strategy.kind === "unavailable") {
      throw new UraError("URA_REQUIRES_MAINTAINED_DISTRIBUTION", "URA credentials are unavailable.");
    }
    if (strategy.kind === "token_broker") {
      return invokeBroker(strategy.brokerUrl, service, params);
    }

    const url = new URL(INVOKE_URL);
    url.searchParams.set("service", service);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const call = async (tokenValue: string) =>
      fetch(url, {
        headers: {
          accept: "application/json",
          AccessKey: strategy.accessKey,
          Token: tokenValue
        },
        signal: AbortSignal.timeout(20000)
      });

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await call(await this.getToken());
      try {
        if (response.status === 401 || response.status === 403) {
          throw new UraError("URA_AUTH_FAILED", "URA authentication failed.");
        }
        return await parseUraResponse(response);
      } catch (error) {
        lastError = error;
        if (!(error instanceof UraError) || error.code !== "URA_AUTH_FAILED" || attempt === 1) {
          throw error;
        }
        this.token = null;
      }
    }
    throw lastError instanceof Error ? lastError : new UraError("URA_SERVICE_UNAVAILABLE", "URA request failed.");
  }

  async getToken(): Promise<string> {
    const strategy = getCredentialStrategy();
    if (strategy.kind !== "env_access_key") {
      throw new UraError("URA_REQUIRES_MAINTAINED_DISTRIBUTION", "Direct URA token generation requires URA_ACCESS_KEY.");
    }

    const today = singaporeDate();
    if (this.token && this.tokenDate === today) return this.token;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.fetchToken(strategy.accessKey, today).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async fetchToken(accessKey: string, today: string): Promise<string> {
    const response = await fetch(TOKEN_URL, {
      headers: {
        accept: "application/json",
        AccessKey: accessKey
      },
      signal: AbortSignal.timeout(15000)
    });
    if (response.status === 429) {
      throw new UraError("URA_RATE_LIMITED", "URA token endpoint rate limited.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UraError("URA_AUTH_FAILED", `URA access key ${redactSecret(accessKey)} was rejected.`);
    }
    const result = await parseUraResponse(response);
    const token = getString(result, "Result");
    if (!token) {
      throw new UraError("URA_SERVICE_UNAVAILABLE", "URA token response did not include Result.");
    }
    this.token = token;
    this.tokenDate = today;
    return token;
  }
}

export class UraError extends Error {
  constructor(
    public readonly code:
      | "URA_REQUIRES_MAINTAINED_DISTRIBUTION"
      | "URA_AUTH_FAILED"
      | "URA_RATE_LIMITED"
      | "URA_SERVICE_UNAVAILABLE",
    message: string
  ) {
    super(message);
  }
}

async function invokeBroker(brokerUrl: string, service: string, params: Record<string, string | number>): Promise<unknown> {
  try {
    const response = await fetch(brokerUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ service, params }),
      signal: AbortSignal.timeout(60000)
    });
    return parseUraResponse(response);
  } catch (error) {
    if (error instanceof UraError) throw error;
    throw new UraError("URA_SERVICE_UNAVAILABLE", `URA broker request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function parseUraResponse(response: Response): Promise<unknown> {
  if (response.status === 429) throw new UraError("URA_RATE_LIMITED", "URA rate limit exceeded.");
  if (!response.ok) {
    const payload = await tryJson(response);
    const code = String(payload?.error?.code ?? payload?.code ?? "");
    const message = String(payload?.error?.message ?? payload?.Message ?? payload?.message ?? `URA returned HTTP ${response.status}.`);
    if (code === "URA_RATE_LIMITED" || response.status === 429) throw new UraError("URA_RATE_LIMITED", message);
    if (code === "URA_AUTH_FAILED" || response.status === 401 || response.status === 403) throw new UraError("URA_AUTH_FAILED", "URA authentication failed.");
    throw new UraError("URA_SERVICE_UNAVAILABLE", message);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const status = String(payload.Status ?? payload.status ?? "Success").toLowerCase();
  const message = String(payload.Message ?? payload.message ?? "");
  if (status && status !== "success") {
    if (/auth|token|access|key/i.test(message)) throw new UraError("URA_AUTH_FAILED", "URA authentication failed.");
    throw new UraError("URA_SERVICE_UNAVAILABLE", message || "URA returned unsuccessful status.");
  }
  return payload;
}

async function tryJson(response: Response): Promise<Record<string, any> | null> {
  try {
    return (await response.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

function singaporeDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found ? found : null;
}
