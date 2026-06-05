# npm Release

## Package Name

Default package name: `sg-housing-data`

CLI binary: `sg-housing`

MCP command: `sg-housing mcp`

## Public Release Rules

- Do not publish a real URA `AccessKey`.
- Public npm releases run in `public` mode unless a user supplies `URA_ACCESS_KEY`, a maintained token broker configuration, or the package has a maintained default proxy URL.
- Detailed URA Data Service tools must degrade with `URA_REQUIRES_MAINTAINED_DISTRIBUTION` when credentials are unavailable.
- Machine-readable CLI output goes to stdout. Logs and diagnostics go to stderr.
- Update checks are explicit or doctor-only: `sg-housing mcp` must not print upgrade prompts or perform install actions on startup.

## Update Guidance

The package exposes update guidance in two places:

```bash
sg-housing update-check --json
sg-housing update-check --force --json
sg-housing doctor --json
```

The check reads `https://registry.npmjs.org/sg-housing-data/latest`, caches the latest version under the user cache directory for 24 hours, and returns a structured `next_action` such as `Run npm install -g sg-housing-data@latest` when a newer version exists. It is advisory only; the package never self-installs.

For managed or offline environments:

```bash
SG_HOUSING_DISABLE_UPDATE_CHECK=1 sg-housing doctor --json
```

The MCP server also exposes `check_package_update` for agents that need maintenance guidance. Agent-facing data tools should not call it during normal housing queries.

## Pre-Release Checklist

```bash
npm ci
npm run prepublishOnly
npm pack --dry-run
node dist/cli.js --help
node dist/cli.js update-check --json
node dist/cli.js sources --json
node dist/cli.js rows --source cea_residential_transactions --filter town=YISHUN --limit 3 --json
node dist/cli.js private sales --project TURQUOISE --district 04 --limit 5 --json
```

The private sale command should return a structured URA credential error in public mode, or bounded compact rows when an approved credential strategy is configured.

## Maintained URA Proxy

For zero-config private residential tools, deploy the Vercel proxy in [VERCEL_PROXY.md](VERCEL_PROXY.md), set `URA_ACCESS_KEY` only in Vercel environment variables, and set the deployed `/api/ura` URL as the maintained default in `src/credentials.ts` before publishing a maintained release.

Smoke test before release:

```bash
curl https://<project>.vercel.app/api/ura
SG_HOUSING_URA_TOKEN_BROKER_URL=https://<project>.vercel.app/api/ura node dist/cli.js doctor --mcp --json
SG_HOUSING_URA_TOKEN_BROKER_URL=https://<project>.vercel.app/api/ura node dist/cli.js private sales --project TURQUOISE --limit 5 --json
```

## Publish

```bash
npm login
npm publish --access public
```

For a private maintained distribution, publish to the private registry or scope configured by the maintainer. Use a token broker or another approved credential strategy; do not put an extractable shared URA key in a public artifact.

## Claude CLI Config

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
