import { getDataGovStrategy } from "./credentials.js";

export type DatastoreSearchParams = {
  resourceId: string;
  limit: number;
  offset?: number;
  filters?: Record<string, string | number | Array<string | number>>;
  sort?: string;
};

export type DatastoreSearchResult = {
  records: Record<string, unknown>[];
  total: number | null;
  resource_id: string;
};

const DATASTORE_SEARCH_URL = "https://data.gov.sg/api/action/datastore_search";

export class DataGovClient {
  async searchRows(params: DatastoreSearchParams): Promise<DatastoreSearchResult> {
    const strategy = getDataGovStrategy();
    if (strategy.kind === "proxy") {
      const response = await fetch(strategy.proxyUrl, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          resource_id: params.resourceId,
          limit: params.limit,
          offset: params.offset ?? 0,
          filters: params.filters,
          sort: params.sort
        }),
        signal: AbortSignal.timeout(15000)
      });
      return parseDatastoreResponse(response, params.resourceId, "data.gov.sg proxy");
    }

    const url = new URL(DATASTORE_SEARCH_URL);
    url.searchParams.set("resource_id", params.resourceId);
    url.searchParams.set("limit", String(params.limit));
    url.searchParams.set("offset", String(params.offset ?? 0));
    if (params.filters && Object.keys(params.filters).length > 0) {
      url.searchParams.set("filters", JSON.stringify(params.filters));
    }
    if (params.sort) {
      url.searchParams.set("sort", params.sort);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (strategy.kind === "direct_with_key") headers["x-api-key"] = strategy.apiKey;
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000)
    });

    return parseDatastoreResponse(response, params.resourceId, "data.gov.sg");
  }
}

async function parseDatastoreResponse(response: Response, fallbackResourceId: string, serviceName: string): Promise<DatastoreSearchResult> {
    if (response.status === 429) {
      throw new DataGovError("DATA_GOV_RATE_LIMITED", "data.gov.sg rate limit exceeded.");
    }
    if (!response.ok) {
      throw new DataGovError("DATA_GOV_UNAVAILABLE", `${serviceName} returned HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as {
      success?: boolean;
      error?: unknown;
      result?: {
        records?: Record<string, unknown>[];
        total?: number;
        resource_id?: string;
      };
    };

    if (!payload.success || !payload.result) {
      throw new DataGovError("DATA_GOV_UNAVAILABLE", `${serviceName} returned an unsuccessful payload.`);
    }

    return {
      records: payload.result.records ?? [],
      total: typeof payload.result.total === "number" ? payload.result.total : null,
      resource_id: payload.result.resource_id ?? fallbackResourceId
    };
}

export class DataGovError extends Error {
  constructor(
    public readonly code: "DATA_GOV_RATE_LIMITED" | "DATA_GOV_UNAVAILABLE",
    message: string
  ) {
    super(message);
  }
}
