# sg-housing-data

Local CLI and MCP server for Singapore housing/property public data.

Primary use case: run `sg-housing mcp` from Claude CLI and ask questions over curated HDB, CEA, data.gov.sg, and URA Data Service sources.

Detailed URA Data Service tools use the maintained Vercel URA proxy by default. End users do not configure URA credentials, and public packages do not embed URA credentials.

The proxy is documented in [docs/VERCEL_PROXY.md](docs/VERCEL_PROXY.md). The local package calls that proxy unless a maintainer explicitly sets `SG_HOUSING_URA_TOKEN_BROKER_URL` for another proxy deployment.

## Development

```bash
npm install
npm run build
node dist/cli.js --help
node dist/cli.js update-check --json
```

`sg-housing doctor --json` includes a non-blocking package update check, cached for 24 hours.
Set `SG_HOUSING_DISABLE_UPDATE_CHECK=1` to disable version checks in locked-down environments.

## npm Release

See [docs/NPM_RELEASE.md](docs/NPM_RELEASE.md).

## URA Proxy

See [docs/VERCEL_PROXY.md](docs/VERCEL_PROXY.md).

## Claude CLI

```json
{
  "mcpServers": {
    "sg-housing": {
      "command": "sg-housing",
      "args": ["mcp"]
    }
  }
}
```
