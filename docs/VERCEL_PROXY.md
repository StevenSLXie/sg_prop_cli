# Vercel Maintained Proxies

These proxies keep upstream API keys on Vercel and let the local CLI/MCP call detailed URA private residential tools and data.gov.sg datastore sources without asking end users to configure credentials.

## URA Proxy

Endpoint:

```text
POST https://<project>.vercel.app/api/ura
```

Request body:

```json
{
  "service": "PMI_Resi_Transaction",
  "params": {
    "batch": 1
  }
}
```

Response body is the URA Data Service JSON payload. The local package already knows how to normalize it into bounded agent-friendly rows.

Health check:

```bash
curl https://<project>.vercel.app/api/ura
```

The health check reports whether `URA_ACCESS_KEY` is configured, but it does not generate a URA token.

## Allowed Services

The proxy is intentionally not a generic URA tunnel.

- `PMI_Resi_Transaction`: requires `params.batch` as integer `1..4`.
- `PMI_Resi_Rental`: requires `params.refPeriod` in URA `YYqN` format, for example `26q1`.
- `PMI_Resi_Rental_Median`: no params.
- `PMI_Resi_Developer_Sales`: no params.

## Deploy

```bash
npm install
npm run prepublishOnly
npm install -g vercel
vercel
vercel env add URA_ACCESS_KEY production
vercel env add URA_ACCESS_KEY preview
vercel --prod
```

After deployment:

```bash
curl https://<project>.vercel.app/api/ura
```

If testing a custom proxy before making it the default, point the local package at it:

```bash
SG_HOUSING_URA_TOKEN_BROKER_URL=https://<project>.vercel.app/api/ura sg-housing doctor --mcp --json
SG_HOUSING_URA_TOKEN_BROKER_URL=https://<project>.vercel.app/api/ura sg-housing private sales --project TURQUOISE --limit 5 --json
```

For the smooth public npm release, keep the deployed proxy URL as the maintained default before publishing. The normal local package path should use the Vercel proxy regardless of distribution mode; `URA_ACCESS_KEY` belongs in Vercel environment variables, not on end-user machines.

## data.gov.sg Proxy

Endpoint:

```text
POST https://<project>.vercel.app/api/data-gov
```

Request body:

```json
{
  "resource_id": "d_8b84c4ee58e3cfc0ece0d773c8ca6abc",
  "limit": 100,
  "offset": 0,
  "filters": {
    "town": "BUKIT MERAH"
  },
  "sort": "month desc"
}
```

The proxy forwards only allowlisted data.gov.sg Datastore Search requests and adds `x-api-key` when `DATA_GOV_SG_API_KEY` is configured on Vercel.

Health check:

```bash
curl https://<project>.vercel.app/api/data-gov
```

The health check reports whether `DATA_GOV_SG_API_KEY` is configured, but it does not call data.gov.sg.

Allowed request shape:

- `resource_id` must be one of the dataset ids exposed by the package registry.
- `limit` must be `1..500`.
- `offset` must be a non-negative integer.
- `filters` must be a small object with string/number values or arrays of string/number values.
- `sort` must look like `field asc` or `field desc`.

Deploy the data.gov.sg key:

```bash
vercel env add DATA_GOV_SG_API_KEY production
vercel env add DATA_GOV_SG_API_KEY preview
vercel --prod
```

If testing a custom data.gov.sg proxy before making it the default:

```bash
SG_HOUSING_DATA_GOV_PROXY_URL=https://<project>.vercel.app/api/data-gov sg-housing doctor --mcp --json
SG_HOUSING_DATA_GOV_PROXY_URL=https://<project>.vercel.app/api/data-gov sg-housing rows --source hdb_median_resale --limit 5 --json
```

For local development without the proxy:

```bash
SG_HOUSING_DATA_GOV_DIRECT=1 DATA_GOV_SG_API_KEY=<key> sg-housing rows --source hdb_median_resale --limit 5 --json
```

## Security Notes

- Do not commit `URA_ACCESS_KEY`.
- Do not commit `DATA_GOV_SG_API_KEY`.
- Do not print URA tokens or access keys in logs.
- The proxy stores the daily URA token in serverless memory only. Vercel may cold-start or run multiple instances, so more than one token may be generated per day.
- The endpoints use service, dataset, and parameter allowlists. Add durable rate limiting before publishing a widely used package or advertising the endpoints publicly.
- If abuse becomes a concern, move from these simple proxies to a small authenticated API proxy with durable rate limits and cache.
