# Analysis Tools V2 Specification

Status: Draft  
Scope: `sg-housing-data` MCP and CLI analysis workflows  
Non-goal: caching. V2 must reduce repeated calls by better tool semantics before adding caches.

## 1. Problem

The current MCP tools are optimized for bounded evidence retrieval:

- `find_private_residential_sale_comparables` answers one comparable-sale query.
- `query_housing_rows` returns compact evidence rows.
- `aggregate_housing_rows` performs one generic data.gov.sg aggregation.

This is not sufficient for user questions such as:

> Compare Parc Riviera, Normanton Park, Parc Esta, D'Leedon, and Sims Urban Oasis from 2025-Q1 to 2026-Q2, especially 3-bedroom-plus prices.

The model must currently decompose this into many tool calls: by project, quarter, and segment. For URA private sales, each project call can scan all four URA transaction batches when `district` is not provided. The same raw batches are repeatedly fetched and flattened.

V2 introduces analysis tools that accept the full analytical intent once, scan the minimal candidate source set once, and return compact grouped tables.

## 2. Design Principles

1. **Intent-level tools over row-level loops.** If the user asks for a trend, comparison, cohort, or table, the MCP tool should accept that analysis directly.
2. **Scan once, aggregate many ways.** Multiple projects, quarters, segments, and metrics should share the same source scan.
3. **Return tables, not raw datasets.** The server should do local grouping and summary calculation, returning compact long or wide tables.
4. **Use source-specific pruning before scanning.** URA should prune by batch; HDB/data.gov.sg should prune by dataset span and server-side exact filters.
5. **Keep evidence retrieval separate.** Analysis tools provide high-level tables. Existing row tools remain available for sampled evidence rows.
6. **Make approximation explicit.** If bedrooms are unavailable and area is used as a proxy, the response must say so in metadata.
7. **No cache dependency.** The implementation may later add in-process or durable caching, but correctness and reduced call count must not depend on caching.

## 3. Current Behavior To Replace

### 3.1 URA Private Sales

Current implementation:

1. Resolve filters for one query.
2. Choose `candidateBatches(input.district)`.
3. If `district` is absent, scan batches `[1, 2, 3, 4]`.
4. Invoke `PMI_Resi_Transaction` once per batch.
5. Flatten every transaction.
6. Apply project/date/area/type filters locally.
7. Return rows and a single summary.

Problems:

- A project keyword does not reduce batch scan.
- Multiple projects require repeated tool calls.
- Multiple quarters require repeated tool calls.
- Multiple segments, such as all transactions and large units, require repeated tool calls.
- The technical design mentions URA cursors and early row stops, but current comparable output always returns `next_cursor: null`.

### 3.2 HDB/data.gov.sg

Current implementation is stronger:

- Exact filters are pushed down to data.gov.sg where possible.
- HDB resale month filters prune historical dataset IDs.
- HDB resale recent scans sort newest-first and stop after the requested month floor.
- Aggregation supports count, grouped count, top-N, and one numeric summary.

Problems:

- One call only computes one aggregation operation and one `value_field`.
- Multiple metrics require multiple calls.
- Multiple analytical segments require multiple calls.
- Derived analysis dimensions such as quarter must be supplied by the caller or implemented ad hoc.

## 4. New Tool: `analyze_private_residential_sales`

### 4.1 Purpose

Analyze URA private residential sale transactions across multiple projects, time buckets, segments, and metrics in one MCP call.

Use this tool for:

- project-to-project resale trend comparisons;
- quarterly/monthly price trends;
- large-unit proxy analysis;
- buyer shortlist summary tables;
- project liquidity and price distribution summaries.

Use `find_private_residential_sale_comparables` only when the user needs compact evidence rows.

### 4.2 Input Schema

```ts
type AnalyzePrivateResidentialSalesInput = {
  projects?: string[];
  streets?: string[];
  districts?: string[];
  market_segments?: string[];
  property_types?: string[];
  type_of_sale?: "new_sale" | "sub_sale" | "resale";
  from?: string; // YYYY-MM or YYYY-MM-DD
  to?: string; // YYYY-MM or YYYY-MM-DD
  min_area_sqm?: number;
  max_area_sqm?: number;
  min_price?: number;
  max_price?: number;
  min_price_psf?: number;
  max_price_psf?: number;
  floor_ranges?: string[];
  group_by?: Array<"project" | "street" | "district" | "market_segment" | "property_type" | "type_of_sale" | "month" | "quarter" | "year" | "floor_range">;
  segments?: AnalysisSegment[];
  metrics?: AnalysisMetric[];
  output?: "long_table" | "wide_table";
  max_output_rows?: number;
  max_output_columns?: number;
  include_diagnostics?: boolean;
};

type AnalysisSegment = {
  name: string;
  min_area_sqm?: number;
  max_area_sqm?: number;
  min_price?: number;
  max_price?: number;
  min_price_psf?: number;
  max_price_psf?: number;
  floor_ranges?: string[];
  proxy_for?: AnalysisProxyAssumption;
};

type AnalysisProxyAssumption = {
  unavailable_field: "bedrooms" | string;
  requested: string;
  proxy_field: "area_sqm" | string;
  proxy_op: "gte" | "lte" | "range";
  proxy_value?: number;
  proxy_min?: number;
  proxy_max?: number;
  rationale?: string;
};

type AnalysisMetric =
  | "count"
  | "price_min"
  | "price_max"
  | "price_avg"
  | "price_median"
  | "price_p25"
  | "price_p75"
  | "price_psf_min"
  | "price_psf_max"
  | "price_psf_avg"
  | "price_psf_median"
  | "price_psf_p25"
  | "price_psf_p75"
  | "area_sqm_median";
```

Defaults:

- `type_of_sale`: unset, but agents should set `"resale"` when the user asks recent comparable resale prices.
- `group_by`: `["project"]`.
- `segments`: `[{ name: "all" }]`.
- `metrics`: `["count", "price_median", "price_psf_median", "area_sqm_median"]`.
- `output`: `"long_table"`.
- `max_output_rows`: 500.
- `max_output_columns`: 80.

Validation:

- `projects`, `streets`, and `districts` are optional, but at least one meaningful filter must be present unless the caller sets a deliberately broad market filter such as `districts` or `market_segments`.
- `segments[].name` must be unique, non-empty, and safe for table keys.
- Maximum projects: 30.
- Maximum segments: 8.
- Maximum materialized output rows after group-by x segment expansion: `max_output_rows`, capped at 500. If exceeded, return a validation error asking the caller to narrow filters, reduce grouping, reduce segments, or request `wide_table`.
- Maximum wide-table columns: `max_output_columns`, capped at 80.
- If `segments[].proxy_for` is present, the response must include a structured assumption object and a human-readable assumption string for that segment.
- If `segments[].proxy_for.unavailable_field` is `"bedrooms"`, the implementation must not infer bedrooms from URA rows. It must state that URA private sale transactions do not include bedroom count.

### 4.3 URA Batch Pruning

URA `PMI_Resi_Transaction` accepts only `batch`, so project keyword filtering cannot be pushed to URA directly. V2 must add a resolver before scanning.

Resolver inputs:

- `districts`;
- `projects`;
- `streets`;
- optional existing static project index.

Resolver output:

```ts
type UraCandidatePlan = {
  batches: number[];
  resolved_projects: Array<{
    input: string;
    matched_project: string;
    street?: string;
    district?: string;
    batch?: number;
    confidence: "exact" | "normalized_exact" | "contains" | "ambiguous" | "unresolved";
  }>;
  unresolved_inputs: string[];
  broad_scan_reason?: string;
};
```

Rules:

- If `districts` are provided, convert districts to batches.
- If projects or streets resolve to districts, include only those batches.
- If both district and project filters exist, use the intersection where possible.
- If a project is unresolved but a street resolves, use the street batch and keep project filtering local.
- If inputs are ambiguous across batches, include the union and report ambiguity in diagnostics.
- If no batch can be inferred, scan `[1, 2, 3, 4]` and set `broad_scan_reason`.

V2 requires a packaged static project index. The resolver must not perform a hidden all-batch scan merely to discover a project batch, because that would preserve the current user-visible latency problem for the first analysis call.

The packaged index can be generated by a maintenance script from a known-good URA transaction snapshot and committed as compact JSON. The runtime resolver may still broad-scan `[1, 2, 3, 4]` when an input is genuinely unresolved or ambiguous, but it must report that reason in diagnostics.

Known URA private sale batch mapping:

| District range | Batch |
|---|---:|
| 01-07 | 1 |
| 08-14 | 2 |
| 15-21 | 3 |
| 22-28 | 4 |

### 4.4 Execution

1. Normalize filters and date bounds.
2. Resolve candidate batches.
3. Fetch each candidate batch once.
4. Flatten sale rows.
5. Apply base filters.
6. Derive fields:
   - `month` from `contract_month`;
   - `quarter` from `contract_month`;
   - `year` from `contract_month`.
7. For each row, evaluate each segment.
8. For each matching segment, add the row to the group accumulator.
9. Materialize requested metrics.

### 4.5 Output

```ts
type AnalyzePrivateResidentialSalesResult = ResultEnvelope<{
  rows: Array<Record<string, unknown>>;
  columns: string[];
  assumptions: AnalysisAssumption[];
  diagnostics?: {
    candidate_batches: number[];
    resolved_projects: UraCandidatePlan["resolved_projects"];
    unresolved_inputs: string[];
    broad_scan_reason?: string;
    rows_scanned: number;
    rows_matched: number;
    output_rows: number;
  };
}>;

type AnalysisAssumption = {
  code: string;
  message: string;
  segment?: string;
  proxy_for?: AnalysisProxyAssumption;
};
```

Long table example:

```json
{
  "ok": true,
  "tool": "analyze_private_residential_sales",
  "data": {
    "columns": ["project", "quarter", "segment", "count", "price_median", "price_psf_median", "area_sqm_median"],
    "rows": [
      {
        "project": "PARC ESTA",
        "quarter": "2026-Q1",
        "segment": "large_proxy_85sqm",
        "count": 14,
        "price_median": 2655000,
        "price_psf_median": 2572.7,
        "area_sqm_median": 95.5
      }
    ],
    "assumptions": [
      {
        "code": "BEDROOMS_UNAVAILABLE_AREA_PROXY",
        "message": "URA private residential sale transactions do not include bedroom count; segment 'large_proxy_85sqm' uses area_sqm >= 85 as a proxy for requested bedrooms '3+'.",
        "segment": "large_proxy_85sqm",
        "proxy_for": {
          "unavailable_field": "bedrooms",
          "requested": "3+",
          "proxy_field": "area_sqm",
          "proxy_op": "gte",
          "proxy_value": 85
        }
      }
    ]
  },
  "meta": {
    "source_keys": ["ura_private_residential_transactions"],
    "rows_returned": 1,
    "rows_scanned": 137289,
    "batches_scanned": 2,
    "complete": true,
    "truncated": false,
    "next_cursor": null
  }
}
```

Envelope metadata:

- `complete=true` only when all candidate batches were scanned.
- `truncated=false` for successful analysis output.
- `source_keys=["ura_private_residential_transactions"]`.
- Caveats must include: no unit number, project-level coordinates, not valuation advice.
- `data.diagnostics` is returned when `include_diagnostics=true`; essential scan counts remain in `meta` for consistency with existing tools.

## 5. New Tool: `analyze_hdb_resale_transactions`

### 5.1 Purpose

Analyze HDB resale transactions across multiple towns, flat types, streets, time buckets, lease cohorts, and metrics in one MCP call.

Use this tool for:

- quarterly HDB resale trends;
- town and flat-type comparison tables;
- remaining-lease cohort analysis;
- price and price-per-sqm summaries.

### 5.2 Input Schema

```ts
type AnalyzeHdbResaleTransactionsInput = {
  towns?: string[];
  flat_types?: string[];
  street_names?: string[];
  flat_models?: string[];
  storey_ranges?: string[];
  from?: string;
  to?: string;
  min_floor_area_sqm?: number;
  max_floor_area_sqm?: number;
  min_remaining_lease_months?: number;
  max_remaining_lease_months?: number;
  min_resale_price?: number;
  max_resale_price?: number;
  group_by?: Array<"town" | "flat_type" | "street_name" | "flat_model" | "storey_range" | "month" | "quarter" | "year" | "remaining_lease_bucket">;
  segments?: HdbAnalysisSegment[];
  metrics?: HdbAnalysisMetric[];
  output?: "long_table" | "wide_table";
  remaining_lease_bucket_size_months?: number;
  max_output_rows?: number;
  max_output_columns?: number;
  limit_rows_scanned?: number;
  allow_partial?: boolean;
  include_diagnostics?: boolean;
};

type HdbAnalysisSegment = {
  name: string;
  min_floor_area_sqm?: number;
  max_floor_area_sqm?: number;
  min_remaining_lease_months?: number;
  max_remaining_lease_months?: number;
  min_resale_price?: number;
  max_resale_price?: number;
  flat_types?: string[];
  storey_ranges?: string[];
};

type HdbAnalysisMetric =
  | "count"
  | "resale_price_min"
  | "resale_price_max"
  | "resale_price_avg"
  | "resale_price_median"
  | "resale_price_p25"
  | "resale_price_p75"
  | "price_psm_avg"
  | "price_psm_median"
  | "price_psm_p25"
  | "price_psm_p75"
  | "floor_area_sqm_median"
  | "remaining_lease_months_median";
```

Derived fields:

- `quarter`;
- `year`;
- `remaining_lease_months`;
- `remaining_lease_bucket`;
- `price_psm = resale_price / floor_area_sqm`.

Lease bucket rules:

- `remaining_lease_bucket_size_months` defaults to 120 months.
- Buckets are floor-based: `bucket_floor = Math.floor(remaining_lease_months / bucket_size) * bucket_size`.
- With the default 120-month bucket size, labels are year ranges such as `70-79y`, `80-89y`, and `90-99y`.
- If `remaining_lease_months` is missing or unparsable, use `unknown`.

Defaults:

- `group_by`: `["town", "flat_type"]`.
- `segments`: `[{ name: "all" }]`.
- `metrics`: `["count", "resale_price_median", "price_psm_median", "floor_area_sqm_median"]`.
- `limit_rows_scanned`: 20000.
- `remaining_lease_bucket_size_months`: 120.
- `max_output_rows`: 500.
- `max_output_columns`: 80.

Flat type normalization:

- Canonical values must match data.gov.sg HDB resale values:
  - `1 ROOM`
  - `2 ROOM`
  - `3 ROOM`
  - `4 ROOM`
  - `5 ROOM`
  - `EXECUTIVE`
  - `MULTI-GENERATION`
- User aliases must normalize before exact filter pushdown:
  - `3-room`, `3 room`, `three room` -> `3 ROOM`;
  - `4-room`, `4 room`, `four room` -> `4 ROOM`;
  - `5-room`, `5 room`, `five room` -> `5 ROOM`;
  - `exec`, `executive apartment`, `executive maisonette` -> `EXECUTIVE` only when used as a flat type filter. `flat_model` remains separate.
- If a flat type alias cannot be normalized to a canonical value, return `VALIDATION_ERROR` with allowed canonical values.
- The same normalization applies to top-level `flat_types` and `segments[].flat_types`.

### 5.3 Output

HDB analysis must use the same envelope convention as URA analysis.

```ts
type AnalyzeHdbResaleTransactionsResult = ResultEnvelope<{
  rows: Array<Record<string, unknown>>;
  columns: string[];
  assumptions: AnalysisAssumption[];
  partial?: boolean;
  diagnostics?: {
    dataset_ids: string[];
    server_filters?: Record<string, unknown>;
    rows_scanned: number;
    rows_matched: number;
    pages_scanned: number;
    backend_total?: number | null;
    output_rows: number;
  };
}>;
```

Envelope metadata:

- `source_keys=["hdb_resale_transactions"]`.
- `rows_returned` equals `data.rows.length`.
- `rows_scanned`, `pages_scanned`, `backend_total`, `complete`, `truncated`, and `next_cursor` live in `meta`, consistent with existing data.gov.sg tools.
- `data.partial=true` is present only when `allow_partial=true` and the scan cap was reached.
- `next_cursor=null` for percentile-bearing V2 HDB analysis outputs.
- `data.assumptions` is an empty array unless the caller uses a segment or grouping option that requires an explicit approximation.

### 5.4 HDB Scan Planning

Reuse and extend current data.gov.sg behavior:

- prune HDB resale datasets by month range;
- sort recent scans newest-first when `from` is present;
- push exact filters to data.gov.sg for `town`, `flat_type`, `street_name`, `flat_model`, and `storey_range`;
- keep range and derived filters local;
- stop when month falls below `from` on newest-first scans.

Differences from current `aggregate_housing_rows`:

- compute multiple metrics in one pass;
- compute multiple segments in one pass;
- support derived time buckets and lease buckets;
- return a compact table rather than one generic aggregation result.

### 5.5 Partial Results

HDB sources can be large. If `limit_rows_scanned` is reached:

- return `complete=false`;
- return `truncated=true`;
- if `allow_partial=false`, return a `SCAN_LIMIT_REACHED` error with partial diagnostics and no authoritative table;
- if `allow_partial=true`, include partial rows with `data.partial=true` and metadata making incompleteness explicit;
- do not promise resumable cursor support for exact percentile metrics (`median`, `p25`, `p75`) in V2, because carrying per-group value arrays can exceed cursor and response budgets;
- `next_cursor` must be `null` for percentile-bearing HDB analysis outputs unless a future bounded accumulator design is implemented and tested;
- exact count/avg/min/max-only analysis may add cursor support later, but it is not required for V2 acceptance.

## 6. Shared Analysis Engine

Implement shared internals rather than duplicating grouping logic.

```ts
type NormalizedRow = Record<string, unknown>;

type AnalysisEngineInput = {
  rows: Iterable<NormalizedRow>;
  groupBy: string[];
  segments: AnalysisSegment[];
  metrics: AnalysisMetric[];
  output: "long_table" | "wide_table";
  maxOutputRows: number;
  maxOutputColumns: number;
};
```

Responsibilities:

- validate group fields and metric fields;
- evaluate segment predicates;
- keep per-group metric accumulators;
- compute median and percentiles;
- produce stable sorted output;
- enforce materialized output row and column limits before returning an MCP response.

Sorting:

1. group fields in input order;
2. `segment` in input segment order.

Median policy:

- Use the existing percentile interpolation behavior for consistency with current summaries.
- Preserve raw numeric precision in structured output; rendering/rounding is an agent responsibility.

Output budget policy:

- `long_table` row count is `group_count * segment_count` after empty groups are removed.
- `wide_table` row count is `group_count`; column count is group columns plus segment/metric columns.
- If `long_table` would exceed `maxOutputRows`, return `VALIDATION_ERROR` before emitting a large table.
- If `wide_table` would exceed `maxOutputColumns`, return `VALIDATION_ERROR` before emitting a large table.
- MCP tools must not return more than 500 analysis rows.

## 7. Backward Compatibility

Existing tools remain:

- `find_private_residential_sale_comparables`;
- `find_private_residential_rental_contracts`;
- `query_housing_rows`;
- `aggregate_housing_rows`.

Descriptions should be updated:

- row/comparable tools: use for evidence rows and narrow comparable inspection;
- analysis tools: use for trends, multi-project comparison, cohort summaries, and multi-metric tables.

No existing input schema should be broken.

## 8. User Experience Requirements

For a question like:

> 看 Parc Riviera, Normanton Park, Parc Esta, D'Leedon 和 Sims Urban Oasis 2025 年初到 2026 年 6 月，6 个季度，尤其三卧以上走势

The agent should make one call to `analyze_private_residential_sales`:

- `projects`: five project names;
- `from`: `2025-01`;
- `to`: `2026-06`;
- `type_of_sale`: `resale`;
- `group_by`: `["project", "quarter"]`;
- `segments`: `all`, `large_proxy_85sqm`;
- `metrics`: count, price median, price psf median, area median.

The response must contain enough diagnostics for the agent to explain:

- source is URA private residential sale transactions;
- bedroom count is unavailable;
- `large_proxy_85sqm` is an area proxy;
- which URA batches were scanned;
- sample size per group and segment.

The `large_proxy_85sqm` segment in examples and tests must be represented as:

```json
{
  "name": "large_proxy_85sqm",
  "min_area_sqm": 85,
  "proxy_for": {
    "unavailable_field": "bedrooms",
    "requested": "3+",
    "proxy_field": "area_sqm",
    "proxy_op": "gte",
    "proxy_value": 85
  }
}
```

## 9. Implementation Stories

Detailed stories live in `docs/ANALYSIS_TOOLS_V2_STORIES.md`.

High-level sequence:

1. Add shared analysis metric engine.
2. Add URA project/batch resolver.
3. Add `analyze_private_residential_sales`.
4. Add tests for the multi-project quarterly large-unit workflow.
5. Add HDB resale analysis adapter.
6. Add `analyze_hdb_resale_transactions`.
7. Update MCP/CLI descriptions and documentation.

## 10. Acceptance Criteria

P0:

- One MCP call can produce the five-project, six-quarter, all-vs-large URA table.
- The URA analysis call fetches each candidate batch at most once.
- Project names that resolve to D05/D10/D14 do not force scanning all four batches.
- Returned `data.assumptions` contains `BEDROOMS_UNAVAILABLE_AREA_PROXY` when the five-project workflow uses `large_proxy_85sqm`.
- Analysis tools return `ResultEnvelope` with analysis payload under `data` and scan/source/completeness fields under `meta`.
- Existing public tools and tests remain compatible.

P1:

- HDB analysis can compute multiple metrics and segments in one scan.
- Tool descriptions guide agents toward analysis tools for trends.
- Diagnostics expose rows scanned, matched rows, candidate batches/datasets, and completeness.
- Broad scans are allowed only with explicit broad filters or clear diagnostics.
- Analysis output enforces `max_output_rows <= 500` and `max_output_columns <= 80`.
- HDB percentile analysis does not claim resumable cursor support unless a bounded percentile accumulator is implemented and tested.
