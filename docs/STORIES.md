# Implementation Stories

## Story 1: Foundation

Deliverables:

- npm package scaffold and TypeScript build.
- Documentation moved under `docs/`.
- Stable source registry and field catalog.
- Shared response envelopes, filter expression types, cursor helpers, and credential mode detection.

Acceptance:

- `npm run typecheck` passes.
- Registry exposes stable source keys and compact default fields.
- No real URA credential is committed.

## Story 2: data.gov.sg CLI

Deliverables:

- data.gov.sg client for metadata and row paging.
- Bounded row query service with `limit`, `cursor`, `select`, `include_raw=false`, `max_pages`, and `max_rows_scanned`.
- Local aggregation service with resumable cursor.
- CLI commands: `sources`, `rows`, `aggregate`, `doctor`, and validated `--help`.

Acceptance:

- CLI can list sources and run bounded CEA/HDB row queries.
- Aggregation refuses authoritative partial ranking unless `allow_partial=true`.
- No row command returns more than MCP/CLI limits.

## Story 3: URA Private Residential

Deliverables:

- URA credential strategy support via `URA_ACCESS_KEY` and token broker placeholder.
- Daily token lifecycle, Singapore-date refresh, single-flight refresh, retry once on token failure.
- Private sale comparables, rental contracts, rental medians, and developer sales services.
- CLI commands under `private`.

Acceptance:

- Public mode degrades gracefully when URA credentials are unavailable.
- With `URA_ACCESS_KEY`, private sale smoke command returns bounded compact rows.
- URA raw backend payloads are returned only with `include_raw=true` and small limits.

## Story 4: MCP, Packaging, and Release

Deliverables:

- Local stdio MCP server registered through `sg-housing mcp`.
- Precise MCP tool descriptions and schemas.
- Advisory package update check exposed through CLI `update-check`, `doctor`, and MCP `check_package_update`.
- Smoke tests for CLI and MCP stdio hygiene.
- npm packaging and release instructions.

Acceptance:

- `npm pack --dry-run` includes only intended artifacts.
- Claude CLI config can launch the server.
- MCP startup remains protocol-clean and never prints upgrade prompts.
- `prepublishOnly` validates typecheck, tests, and build.
