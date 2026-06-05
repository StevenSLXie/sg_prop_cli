# sg-housing-data

Local CLI and MCP server for Singapore housing/property public data.

Use it from Claude Code, Codex CLI, or your terminal to query curated HDB, CEA, data.gov.sg, and URA private residential datasets. Detailed URA Data Service tools use the maintained Vercel URA proxy by default, so end users do not configure URA credentials and the npm package does not embed a URA access key.

## Install

Requirements:

- Node.js 20 or newer.
- npm.

Install globally:

```bash
npm install -g sg-housing-data
```

Check that the CLI is available:

```bash
sg-housing --help
sg-housing doctor --mcp --json
```

The expected `doctor` result should include:

- `distribution_mode: "maintained"`
- `ura_credentials` status `ok`
- `mcp_stdio` status `ok`

Run a small smoke query:

```bash
sg-housing private sales \
  --project TURQUOISE \
  --district 04 \
  --limit 1 \
  --select project,district,contract_month,price,price_psf \
  --json
```

## CLI Usage

List available sources:

```bash
sg-housing sources --json
sg-housing sources --category ura --include-fields --json
```

Query compact rows from a public data.gov.sg-backed source:

```bash
sg-housing rows \
  --source cea_residential_transactions \
  --filter town=YISHUN \
  --limit 5 \
  --json
```

Run bounded local aggregation:

```bash
sg-housing aggregate \
  --source cea_residential_transactions \
  --operation top_n_by_count \
  --group-by salesperson_reg_num,salesperson_name \
  --filter town="ANG MO KIO" \
  --top-n 10 \
  --json
```

Query private residential sale comparables through the maintained URA proxy:

```bash
sg-housing private sales \
  --project TURQUOISE \
  --district 04 \
  --limit 5 \
  --json
```

Every row command is bounded by default and returns compact fields unless you explicitly request more.

## Claude Code

Claude Code supports local stdio MCP servers via `claude mcp add`. Add this server globally for your user:

```bash
claude mcp add --transport stdio --scope user sg-housing -- sg-housing mcp
```

Verify from your shell:

```bash
claude mcp list
```

Then open Claude Code and run:

```text
/mcp
```

You should see `sg-housing` connected with its tools.

Example prompts:

```text
Use sg-housing to find recent private sale comparables for TURQUOISE in district 04.
```

```text
Use sg-housing to rank CEA salespersons by HDB resale transaction count in Ang Mo Kio, then fetch a few evidence rows.
```

Project-scoped alternative:

```bash
claude mcp add --transport stdio --scope project sg-housing -- sg-housing mcp
```

Claude Code will create or update a project `.mcp.json`. Commit that file only if your team wants the same MCP server enabled for the project.

## Codex CLI

Codex CLI can register MCP servers with `codex mcp add`:

```bash
codex mcp add sg-housing -- sg-housing mcp
codex mcp list
```

If you prefer editing the Codex config directly, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.sg-housing]
command = "sg-housing"
args = ["mcp"]
```

Restart Codex after editing the config. In a Codex session, use the MCP status command if available:

```text
/mcp
```

Example prompt:

```text
Use the sg-housing MCP tools to compare private residential sale transactions for TURQUOISE, returning only a compact summary and a few evidence rows.
```

## Zero-Config URA Access

The package calls the maintained proxy by default:

```text
https://sg-housing-data-mcp-spec.vercel.app/api/ura
```

The URA `AccessKey` is stored only as a Vercel environment variable. The local CLI/MCP sends allowed URA service requests to the proxy and receives URA JSON responses. The proxy handles daily URA token generation and refresh.

Maintainer override for a different proxy:

```bash
SG_HOUSING_URA_TOKEN_BROKER_URL=https://your-proxy.example.com/api/ura sg-housing doctor --mcp --json
```

End users should not set `URA_ACCESS_KEY`.

## Updates

Check whether a newer npm package is available:

```bash
sg-housing update-check --json
```

`sg-housing doctor --json` also includes a non-blocking update check, cached for 24 hours. Disable update checks in locked-down environments:

```bash
SG_HOUSING_DISABLE_UPDATE_CHECK=1 sg-housing doctor --json
```

## Development

```bash
npm install
npm run prepublishOnly
node dist/cli.js --help
node dist/cli.js doctor --mcp --json
```

Vercel proxy details are in [docs/VERCEL_PROXY.md](docs/VERCEL_PROXY.md). npm release steps are in [docs/NPM_RELEASE.md](docs/NPM_RELEASE.md).
