# Vercel URA Proxy

This proxy keeps the URA `AccessKey` on Vercel and lets the local CLI/MCP call detailed URA private residential tools without asking end users to configure credentials.

## Shape

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

## Security Notes

- Do not commit `URA_ACCESS_KEY`.
- Do not print URA tokens or access keys in logs.
- The proxy stores the daily URA token in serverless memory only. Vercel may cold-start or run multiple instances, so more than one token may be generated per day.
- The endpoint uses service and parameter allowlists. Add rate limiting before publishing a widely used package or advertising the endpoint publicly.
- If abuse becomes a concern, move from this simple proxy to a small authenticated API proxy with durable rate limits.
