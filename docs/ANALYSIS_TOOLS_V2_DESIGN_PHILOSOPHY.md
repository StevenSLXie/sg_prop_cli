# Analysis Tools V2 Design Philosophy

Analysis Tools V2 changes the MCP from a row-fetch helper into a bounded local analysis engine.

The original pattern made the agent decompose simple analytical questions into many tool calls: project by project, quarter by quarter, segment by segment. That was especially inefficient for URA private sales because the upstream API exposes only four coarse transaction batches. A project query without a district could refetch and flatten the same four batches repeatedly.

V2 is built around five principles.

## 1. Fetch Once, Analyze Locally

When the user asks for a trend table or comparison, the tool should fetch each necessary source partition once and do grouping, segmentation, and metrics locally.

For URA private sales, `analyze_private_residential_sales` resolves project, street, and district inputs to candidate URA batches, invokes each batch at most once, then filters and groups locally. For HDB resale, `analyze_hdb_resale_transactions` scans the relevant data.gov.sg datasets once and feeds normalized rows into the shared engine.

This directly addresses the high-call-count failure mode: five projects across six quarters with all-vs-large segments is one analysis call, not dozens of comparable-row calls.

## 2. Prune With Source Knowledge Before Scanning

Generic tools cannot know the cheapest access path unless source-specific planning happens before the scan.

URA pruning uses a compact committed project/street/district index generated from a known URA transaction snapshot. Resolvable project and street filters map to batch 1-4 before any network call. Ambiguous names still return diagnostics, but if all candidates land in a known batch set, the scan stays narrow.

HDB pruning uses dataset month spans, newest-first sort for recent resale scans, and exact server-side filters for fields data.gov.sg can apply safely. Derived fields such as quarter, year, price per square metre, and lease bucket stay local.

## 3. Make Assumptions Explicit

The tool should not silently invent missing source fields.

URA private sale transactions do not include bedroom count. If a user asks for "3-bedroom and above" analysis, the request must use an explicit proxy such as `area_sqm >= 90`, and the response reports that assumption in `data.assumptions`.

HDB analysis currently has no proxy assumptions, so it still returns `data.assumptions: []` for schema consistency.

## 4. Prefer Validation Errors To Misleading Empty Tables

A typo in an analytical request should not produce an authoritative empty result.

V2 validates:

- `group_by` fields;
- metric base fields;
- segment filters;
- source filters;
- HDB flat-type aliases and canonical values.

Invalid inputs return `VALIDATION_ERROR` before scanning where possible. This is especially important for metrics and bedrooms-like mistakes, where an empty or null table would be easy to misread as a market signal.

## 5. Be Honest About Completeness

For analytical tables, partial results are worse than no result when presented as complete.

HDB analysis refuses authoritative output if the scan cap is reached and `allow_partial` is not set. If `allow_partial=true`, the response marks `data.partial: true`, sets `meta.complete: false`, and does not expose percentile cursors. The user or agent can then narrow filters instead of treating an incomplete percentile table as market truth.

## Current Tool Roles

Use `analyze_private_residential_sales` for URA private-sale trend, comparison, segment, and metric tables.

Use `find_private_residential_sale_comparables` for compact evidence rows or capped shortlist summaries after narrowing.

Use `analyze_hdb_resale_transactions` for HDB resale grouped analysis with multiple metrics and segments in one bounded scan.

Use `query_housing_rows` for evidence rows and `aggregate_housing_rows` for simpler one-operation data.gov.sg summaries.

## What Changed From V1

V1 exposed bounded row and aggregation primitives. It was safe, but it pushed multi-dimensional analysis planning onto the agent.

V2 moves repeated analytical work into the MCP:

- one call can produce a full multi-project, multi-quarter table;
- one source scan can calculate many metrics and segments;
- URA batch selection happens before fetch, not after repeated failed local filters;
- HDB derived fields and flat-type aliases are normalized consistently;
- result envelopes consistently separate `data.rows`, `data.columns`, `data.assumptions`, `data.diagnostics`, and `meta`.

The design target is not unbounded bulk export. The target is a bounded, source-aware analysis surface that makes common housing questions cheap, explicit, and hard to misinterpret.
