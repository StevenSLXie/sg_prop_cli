# Analysis Tools V2 Implementation Stories

Status: Draft  
Parent spec: `docs/ANALYSIS_TOOLS_V2_SPEC.md`

Each story should be implemented, tested, reviewed locally, and committed before moving to the next story. Do not include unrelated worktree changes in these commits.

## Story 1: Shared Analysis Engine

Goal: Add reusable grouping, segment, and metric logic without connecting it to MCP tools yet.

Scope:

- Add `src/analysis-engine.ts`.
- Add `src/analysis-engine.test.ts`.
- Support:
  - long table output;
  - wide table output;
  - multiple segments;
  - multiple numeric metrics;
  - exact median/p25/p75 using existing interpolation semantics;
  - stable sorting by group fields then segment order;
  - output row and column caps.

Acceptance:

- Unit tests cover count, median, p25/p75, multiple segments, empty segments, row cap, and column cap.
- No MCP schema changes yet.
- Existing tests still pass.

Commit message:

`Add shared analysis engine`

## Story 2: URA Project Batch Resolver

Goal: Resolve project/street/district filters to minimal URA sale batches before scanning.

Scope:

- Add a compact static index file, for example `src/data/ura-private-sale-project-index.json`.
- Add a generation script or documented maintenance command if practical.
- Add `src/ura-project-resolver.ts`.
- Normalize project/street strings consistently:
  - trim;
  - uppercase;
  - collapse whitespace;
  - tolerate punctuation differences for names like `D'LEEDON`.
- Map district ranges to batches:
  - 01-07 -> 1;
  - 08-14 -> 2;
  - 15-21 -> 3;
  - 22-28 -> 4.

Acceptance:

- Tests prove the five target projects resolve to batches 1 or 2:
  - Parc Riviera -> batch 1;
  - Normanton Park -> batch 1;
  - Parc Esta -> batch 2;
  - D'Leedon -> batch 2;
  - Sims Urban Oasis -> batch 2.
- Ambiguous/unresolved inputs report diagnostics instead of silently pretending precision.
- No hidden all-batch discovery scan is used for resolvable projects.

Commit message:

`Add URA project batch resolver`

## Story 3: URA Sales Analysis Tool

Goal: Add `analyze_private_residential_sales` using the shared engine and resolver.

Scope:

- Add implementation in a new module or `src/ura-analysis.ts`.
- Register MCP tool in `src/mcp.ts`.
- Add CLI command if consistent with current CLI structure.
- Fetch each candidate URA batch at most once per tool call.
- Derive `month`, `quarter`, and `year`.
- Support structured `proxy_for` assumptions.
- Return `ResultEnvelope<{ rows; columns; assumptions; diagnostics? }>` with scan/source metadata in `meta`.

Acceptance:

- Tests simulate URA batches with fake client and prove each candidate batch is invoked once.
- One test covers the five-project, six-quarter, all-vs-large workflow.
- The large segment returns `BEDROOMS_UNAVAILABLE_AREA_PROXY`.
- Project-resolved workflow does not invoke batches 3 or 4.
- Existing `find_private_residential_sale_comparables` behavior remains compatible.

Commit message:

`Add private residential sales analysis tool`

## Story 4: Tool Guidance And Examples

Goal: Make agents choose the analysis tool for trend/comparison questions.

Scope:

- Update MCP descriptions.
- Update README examples.
- Add one concise example request and response shape for the five-project quarterly workflow.
- Clarify that comparable tools are for evidence rows.

Acceptance:

- `find_private_residential_sale_comparables` description no longer encourages multi-project trend work.
- `analyze_private_residential_sales` description explicitly mentions multi-project, quarterly, segment, and metric analysis.
- Documentation states bedroom count is unavailable in URA sales data.

Commit message:

`Document private sales analysis workflow`

## Story 5: HDB Resale Analysis Adapter

Goal: Add HDB normalized-row adapter and derived fields for the shared analysis engine.

Scope:

- Add HDB analysis module, for example `src/hdb-analysis.ts`.
- Reuse `planDataGovScan`, `exactServerFilters`, and `normalizeRow`.
- Derive:
  - `quarter`;
  - `year`;
  - `remaining_lease_months`;
  - `remaining_lease_bucket`;
  - `price_psm`.
- Define default 120-month lease buckets with stable labels.
- Normalize HDB flat type aliases to canonical data.gov.sg values before exact filter pushdown.

Acceptance:

- Tests prove dataset pruning by month still happens.
- Tests prove exact filters are pushed to data.gov.sg.
- Tests prove lease bucket labels are stable.
- Tests prove `3-room`, `3 room`, and `three room` normalize to `3 ROOM`, including inside segment filters.
- Tests prove multiple metrics and segments are calculated in one scan.

Commit message:

`Add HDB resale analysis adapter`

## Story 6: HDB Resale Analysis Tool

Goal: Expose `analyze_hdb_resale_transactions` through MCP and CLI.

Scope:

- Register MCP tool.
- Add CLI command if consistent with current CLI structure.
- Enforce output row/column caps.
- Enforce partial result policy:
  - no authoritative table when scan cap is hit and `allow_partial=false`;
  - explicit partial table when `allow_partial=true`;
  - no percentile cursor claims in V2.

Acceptance:

- Tests cover partial refusal and allowed partial output.
- Tests cover output caps.
- Tests cover the exact `ResultEnvelope` shape: analysis rows under `data`, diagnostics under `data.diagnostics`, partial marker under `data.partial`, and scan/source/completeness under `meta`.
- Existing `query_housing_rows` and `aggregate_housing_rows` remain compatible.

Commit message:

`Add HDB resale analysis tool`

## Story 7: Final Review, Docs, And Release Readiness

Goal: Ensure V2 design is coherent and implementation has no P0/user-impacting P1 issues.

Scope:

- Run full test suite.
- Run typecheck.
- Run an independent agent review focused on P0/P1 bugs and user experience.
- Fix any P0/P1 findings.
- Add final design philosophy document.

Acceptance:

- Independent review reports no P0 or user-impacting P1 issues.
- `npm test` passes.
- `npm run typecheck` passes.
- Design philosophy document exists and explains V2 principles.

Commit message:

`Document analysis tools v2 design philosophy`
