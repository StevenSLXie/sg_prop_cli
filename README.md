# sg-housing-data

Singapore housing/property data tools for AI agents.

This package provides a local MCP server for Claude Desktop, Claude Code, Codex CLI, and other MCP clients. It exposes curated HDB, CEA, data.gov.sg, and URA private residential data through bounded, agent-friendly tools.

Detailed URA private residential tools work out of the box through a maintained Vercel proxy. End users do not configure URA credentials, and the npm package does not embed a URA access key.

## Install

Install the latest package:

```bash
npm install -g sg-housing-data@latest
```

Optional health check:

```bash
sg-housing doctor --mcp --json
```

Expected result:

- `distribution_mode` is `maintained`
- `ura_credentials` is `ok`
- `mcp_stdio` is `ok`

## Claude Desktop

Claude Desktop uses `claude_desktop_config.json`.

Open Claude Desktop, then go to:

```text
Settings -> Developer -> Edit Config
```

Add this server:

```json
{
  "mcpServers": {
    "sg-housing": {
      "command": "npx",
      "args": ["-y", "sg-housing-data@latest", "mcp"]
    }
  }
}
```

Config file locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

After saving the file, fully quit and restart Claude Desktop. The MCP indicator should show `sg-housing`.

Try:

```text
Use sg-housing to check recent 5-room HDB resale transactions in Bukit Merah.
```

```text
Use sg-housing to find recent D'LEEDON private sale comparables and summarize price PSF.
```

## Claude Code

Add the MCP server at user scope:

```bash
claude mcp add --transport stdio --scope user sg-housing -- npx -y sg-housing-data@latest mcp
```

Verify:

```bash
claude mcp list
```

Inside Claude Code, run:

```text
/mcp
```

Project-scoped alternative:

```bash
claude mcp add --transport stdio --scope project sg-housing -- npx -y sg-housing-data@latest mcp
```

## Codex CLI

Add the MCP server:

```bash
codex mcp add sg-housing -- npx -y sg-housing-data@latest mcp
codex mcp list
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.sg-housing]
command = "npx"
args = ["-y", "sg-housing-data@latest", "mcp"]
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Restart Codex after changing the config.

## What It Can Answer

Examples:

```text
Bukit Merah recent 5-room HDB resale prices, with median and example rows.
```

```text
D'LEEDON recent private sale transactions, summarized by area and price PSF.
```

```text
Find CEA salesperson R060096F and summarize public CEA transaction activity.
```

Notes:

- HDB and CEA data come from public data.gov.sg sources.
- URA private residential transaction tools use the maintained proxy by default.
- CEA transaction records do not include transaction prices.
- URA private sale records do not include unit numbers; coordinates are project-level.
- Results are not valuation advice.

## Maintainers

Release checks:

```bash
npm run prepublishOnly
npm pack --dry-run
```

Vercel proxy details are in [docs/VERCEL_PROXY.md](docs/VERCEL_PROXY.md). npm release steps are in [docs/NPM_RELEASE.md](docs/NPM_RELEASE.md).
