# Singapore Housing Data MCP + CLI Technical Design

Date: 2026-06-05
Status: Draft v0.1
Parent spec: `SPEC.md`

## 1. Design Goals

The primary user experience is Claude CLI using a local MCP server. A terminal user should be able to install the maintained package, add the MCP server, and ask natural property questions without learning data.gov.sg dataset IDs or URA API mechanics.

Key goals:

- Agent-friendly tool interfaces with obvious names and bounded outputs.
- Detailed private residential sale transactions are first-class.
- Users do not configure URA credentials when an approved maintained credential strategy is available.
- Tools return enough source-level data for agents to compose complex analysis.
- Tools must not return large datasets by default or pollute the model context.
- Low-level row/query/aggregate primitives should be preferred over over-specialized high-level workflows; convenience tools are thin wrappers around the same primitives.
- Tools avoid authoritative answers when scans are incomplete.
- CLI commands mirror MCP tools for debugging and scripting.

## 1.1 Context Budget Principles

MCP tools are used inside an LLM context window. The design must treat returned rows as scarce.

Rules:

- Default row limits should be small enough for direct model inspection.
- Large scans may happen internally for aggregation, but large raw row payloads must not be returned by default.
- Every row-returning tool must support `limit`, `cursor`, and `select` or an equivalent field projection mechanism.
- Every row-returning tool must support `include_raw=false` by default. Raw backend payloads are opt-in.
- Prefer returning normalized compact rows and summary metadata over full backend objects.
- Prefer `aggregate_housing_rows` for questions asking "most", "count", "average", "median", "distribution", "trend", or "top".
- Prefer `query_housing_rows` with narrow filters and selected fields when the agent needs source evidence.
- Convenience tools must expose enough low-level controls to avoid context bloat: `limit`, `cursor`, `select`, `include_raw`, and summary controls where applicable.

Default row limits:

- Generic row query default: 50, max 500.
- Comparable convenience tools default: 30, max 300.
- Lookup tools default: 20, max 100.
- Aggregation output default top-N: 10, max 50.
- Internal rows scanned for aggregation default: 5000, max 20000.

If a user explicitly asks for "all records", the tool should not return all records. It should return a bounded page with `next_cursor` and explain how to continue.

Response budget:

- Target MCP response size: under 20 KB for normal calls.
- Hard MCP response size target: under 80 KB. If a response would exceed this, reduce rows returned, omit raw fields, and return `truncated=true` with `next_cursor`.
- Never return more than 500 rows from any MCP tool call.
- Never include nested URA project objects by default; flatten and compact rows.
- `include_raw=true` is allowed only with `limit <= 50` unless the caller also sets an explicit `allow_large_raw=true` in CLI-only workflows. MCP tools should not expose `allow_large_raw` in v1.
- For Claude-oriented tools, summaries should be compact: stats, group counts, caveats, and a small row sample if requested.

Non-goals:

- No persistent local database/cache in v1.
- No exact unit-level private property identity; URA detailed transaction API does not provide unit numbers.
- No valuation advice.

## 2. Runtime Architecture

```text
Claude CLI
  -> local stdio MCP server: sg-housing mcp
      -> tool handlers
          -> source registry
          -> data.gov.sg client
          -> URA Data Service client
          -> normalizers
          -> aggregators

Terminal user
  -> sg-housing CLI
      -> same service layer as MCP
```

Core modules:

- `registry.ts`: source definitions, validation metadata, source availability.
- `credentials.ts`: distribution mode detection and URA credential provider.
- `ura-client.ts`: URA token lifecycle and API invocation.
- `datagov-client.ts`: data.gov.sg metadata, list rows, datastore search.
- `normalize.ts`: date, town, flat type, URA transaction, numeric parsing.
- `scan.ts`: bounded page/batch scanning.
- `aggregate.ts`: group/count/top-N/numeric summaries.
- `mcp.ts`: MCP tool registration.
- `cli.ts`: command parser and output formatting.

## 3. Distribution Modes

Every tool response includes:

```ts
distribution_mode: "public" | "maintained" | "development"
```

Mode detection:

- `maintained`: package or deployment has an approved maintained credential strategy, such as a token broker/proxy, managed local deployment, or explicitly authorized embedded key.
- `development`: source checkout or explicit development build.
- `public`: public npm/repo build without maintained URA credential strategy.

Credential strategy:

- The maintained default proxy is preferred in all normal package modes. `URA_ACCESS_KEY` is a fallback only for forked/internal builds where no proxy URL is configured.
- Token broker/proxy strategy keeps the URA `AccessKey` server-side and returns only a daily URA token or broker-scoped response to the local client.
- Embedded `AccessKey` strategy is not the default. It may be used only for explicitly authorized controlled distributions because package contents are extractable.
- `SG_HOUSING_DISTRIBUTION_MODE` may override mode for testing, but must not make URA tools available without credentials.

Detailed URA tools:

- `maintained`: available out of the box only when the approved credential strategy is healthy.
- `development`: available through the maintained default proxy when configured; direct `URA_ACCESS_KEY` is only a fallback for forked/internal builds without a proxy URL.
- `public`: unavailable with friendly error `URA_REQUIRES_MAINTAINED_DISTRIBUTION`.

## 4. Shared Response Envelope

All MCP tools return JSON text content and, where supported by SDK/client, structured content with the same payload.

Success:

```ts
type SuccessEnvelope<T> = {
  ok: true;
  tool: string;
  distribution_mode: "public" | "maintained" | "development";
  data: T;
  meta: {
    source_keys: string[];
    sources: SourceAttribution[];
    rows_returned?: number;
    rows_scanned?: number;
    pages_scanned?: number;
    batches_scanned?: number;
    backend_total?: number | null;
    complete?: boolean;
    truncated?: boolean;
    next_cursor?: string | null;
    caveats: string[];
    generated_at: string; // ISO timestamp
  };
};
```

Error:

```ts
type ErrorEnvelope = {
  ok: false;
  tool: string;
  distribution_mode: "public" | "maintained" | "development";
  error: {
    code:
      | "VALIDATION_ERROR"
      | "SOURCE_UNAVAILABLE"
      | "URA_REQUIRES_MAINTAINED_DISTRIBUTION"
      | "URA_AUTH_FAILED"
      | "URA_RATE_LIMITED"
      | "URA_SERVICE_UNAVAILABLE"
      | "DATA_GOV_RATE_LIMITED"
      | "DATA_GOV_UNAVAILABLE"
      | "PARTIAL_RANKING_REFUSED"
      | "SCAN_LIMIT_REACHED"
      | "INTERNAL_ERROR";
    message: string;
    recoverable: boolean;
    retry_after_seconds: number | null;
    affected_sources: string[];
    next_action: string;
    details?: Record<string, unknown>;
  };
  partial?: {
    data?: unknown;
    meta: SuccessEnvelope<unknown>["meta"];
  };
};
```

MCP behavior:

- Use MCP `isError` for validation/source/API errors.
- Still include JSON-readable error envelope in content.
- Never include credentials, tokens, or full sensitive headers.
- `SCAN_LIMIT_REACHED`, `PARTIAL_RANKING_REFUSED`, and recoverable mid-scan API failures should include `partial` when any rows or aggregation work were completed.
- Partial error metadata must include `complete=false`, `truncated`, `rows_scanned`, and either `pages_scanned` or `batches_scanned`.
- Include `next_cursor` inside `partial.meta` when continuation is possible.
- `VALIDATION_ERROR.details` should include `allowed_fields`, `allowed_operators`, and an `example_call` whenever the error is caused by invalid filters, operators, sort fields, or source names.

## 5. Source Keys

Source keys are stable agent-facing identifiers.

HDB:

- `hdb_resale_transactions`
- `hdb_rental_transactions`
- `hdb_median_resale`
- `hdb_median_rent`
- `hdb_block_profile`

CEA:

- `cea_salespersons`
- `cea_residential_transactions`

URA Data Service detailed:

- `ura_private_residential_transactions`
- `ura_private_residential_rentals`
- `ura_private_rental_medians`
- `ura_private_developer_sales`

URA data.gov.sg summaries:

- `ura_private_transaction_volume`
- `ura_private_price_index`
- `ura_private_rental_index`
- `ura_non_landed_rental_benchmark`

## 6. MCP Tools

Tool layering:

- Discovery: `list_housing_sources`
- Low-level row access: `query_housing_rows`
- Low-level aggregation: `aggregate_housing_rows`
- Thin convenience wrappers: HDB/CEA/private tools

Low-level principle:

- `query_housing_rows` and `aggregate_housing_rows` are the primary agent-composition surface.
- Convenience tools must be implemented as thin, explainable presets over the same source registry, filters, normalizers, scan contracts, and aggregation helpers.
- Do not add high-level tools that answer one narrow business question if the same job can be done by low-level row and aggregation primitives plus source metadata.
- Add a convenience tool only when it improves discovery or reduces repeated source-specific parameter mapping, such as private sale comparables hiding URA batch mechanics.

Agent guidance:

- Use `list_housing_sources()` first when unsure which source applies; then call `list_housing_sources(source_keys=[...], include_fields=true)` for the narrow candidate source.
- Use `aggregate_housing_rows` for count/top/summary questions before fetching evidence rows.
- Use `query_housing_rows` for narrow evidence pages.
- Use convenience tools when the user asks a common domain question and the needed source is obvious.
- Do not call row tools repeatedly to build a full local copy inside context; use cursors only to inspect additional pages when necessary.
- Prefer `select` to request only fields needed for the answer.
- Prefer `output_mode="summary"` when the user asks for a range, distribution, or high-level comparison and does not need individual evidence rows.

Common output controls:

- `select` projects normalized fields. It must not project arbitrary nested backend payload paths.
- `include_raw=false` is the default for every row-returning tool. When true, add a `raw` object per row only if `limit <= 50` and the response stays under the response budget.
- `output_mode="rows"` returns compact rows and no numeric/group summary except essential metadata.
- `output_mode="summary"` returns summary/group stats and no rows, except a tiny `sample_rows` field only if the tool explicitly documents it.
- `output_mode="both"` returns compact rows plus compact summary. This is the default for comparable tools.
- `cursor` continues bounded row pagination. It is not a license for agents to pull all pages into the prompt.

Summary metadata:

```ts
type SummaryMeta = {
  summary_scope: "returned_rows" | "scanned_candidates" | "complete_matching_set";
  summary_rows_scanned: number;
  summary_sample_size: number;
  summary_complete: boolean;
  summary_truncated: boolean;
};
```

- Every convenience summary must include `SummaryMeta`.
- If `summary_complete=false`, summary labels must use "sample" or "partial" wording and agent-facing caveats must say the numbers may change if more rows are scanned.

### 6.0 Tool Description Contract

Every MCP tool must have a precise `title` and `description`. The description is part of the agent UX; it should help Claude choose the right tool without reading the full docs.

Description rules:

- Start with an action verb.
- State the data source and coverage.
- State whether the tool returns compact rows, an aggregation, or a convenience summary.
- State the main filters the agent should provide.
- State important caveats that affect tool choice.
- Do not use vague descriptions like "Get property data".
- Mention when a tool is not suitable, especially for valuation or exact unit-level answers.

Minimum registration shape:

```ts
server.registerTool("find_private_residential_sale_comparables", {
  title: "Find private residential sale comparables",
  description:
    "Find detailed URA private residential sale transaction rows from the past 5 years. Use for private condo/apartment/landed comparable sale questions by project, district, market segment, sale type, date, area, price, or PSF. Returns transaction rows and summary stats. Not valuation advice; URA data has no unit number and coordinates are project-level.",
  inputSchema: ...
});
```

Required description fields in implementation tests:

- description mentions source: `HDB`, `CEA`, `URA Data Service`, or `data.gov.sg`;
- description mentions output style: `rows`, `summary`, `aggregation`, or `sources`;
- description mentions the strongest caveat when relevant;
- description length target: 180-500 characters.

### 6.0.1 Tool Descriptions

`list_housing_sources`

- Title: `List housing data sources`
- Description: `List curated Singapore housing/property sources exposed by this MCP server, including availability, distribution mode, validation status, fields, filter operators, and caveats. Use this first when an agent needs to discover which HDB, CEA, data.gov.sg, or URA Data Service sources can answer a question.`

`query_housing_rows`

- Title: `Query housing rows`
- Description: `Return a small, bounded page of normalized compact rows from a curated housing source such as HDB resale transactions, CEA residential transactions, or URA datasets. Use when the agent needs source evidence for custom reasoning. Supports filters, selected fields, limits, and cursors. Not for unbounded full-table scans.`

`aggregate_housing_rows`

- Title: `Aggregate housing rows`
- Description: `Run bounded local aggregations over curated housing sources, including count, grouped count, top-N by count, and numeric summaries. Use for questions like top CEA salespersons by town or median resale price over filtered rows. Returns completeness metadata and refuses authoritative rankings on partial scans unless explicitly allowed.`

`find_hdb_resale_comparables`

- Title: `Find HDB resale comparables`
- Description: `Find HDB resale transaction rows and price summaries from data.gov.sg resale flat datasets. Use for HDB comparable sale questions by town, flat type, block, street, month, floor area, or price. Not valuation advice; pre-March 2012 and later records use different date bases.`

`find_hdb_rental_comparables`

- Title: `Find HDB rental comparables`
- Description: `Find HDB rental transaction rows and rent summaries from data.gov.sg. Use for HDB rental comparable questions by town, flat type, block, street, approval month, or rent range. Not rental valuation advice; rows reflect public HDB rental approval records.`

`lookup_hdb_block_profile`

- Title: `Lookup HDB block profile`
- Description: `Lookup HDB block-level property information from data.gov.sg, including completion year, max floor level, residential/commercial flags, and dwelling unit mix. Use when the user asks about a specific HDB block and street. Does not return transaction prices.`

`lookup_cea_salesperson`

- Title: `Lookup CEA salesperson`
- Description: `Lookup active CEA salesperson registration records by registration number, salesperson name, or estate agency. Use to verify a salesperson and agency affiliation. Registration number is the strongest identifier; name-only matches may be ambiguous and include match confidence.`

`query_cea_transactions`

- Title: `Query CEA residential transactions`
- Description: `Return bounded CEA salesperson residential transaction rows for HDB/private sale and rental activity. Use for questions about salesperson experience by town, district, property type, transaction type, represented party, or month. Does not include transaction prices.`

`find_private_residential_sale_comparables`

- Title: `Find private residential sale comparables`
- Description: `Find a compact, bounded set of URA Data Service private residential sale transaction rows from the past 5 years. Use for private condo, apartment, EC, or landed comparable sale questions by project, district, market segment, sale type, date, area, price, or PSF. Not valuation advice; no unit number and coordinates are project-level.`

`find_private_residential_rental_contracts`

- Title: `Find private residential rental contracts`
- Description: `Find detailed URA Data Service private residential rental contract rows from the past 5 years. Use for private rental comparable questions by project, district, property type, bedrooms, reference quarter, area, or rent. Not rental valuation advice; availability depends on maintained distribution credentials.`

`get_private_residential_rental_medians`

- Title: `Get private residential rental medians`
- Description: `Get URA Data Service project-level private non-landed rental median records for the past 3 years, including 25th percentile, median, and 75th percentile PSF rents. Use for project rental benchmarks when detailed contracts are unnecessary. Requires maintained distribution for URA Data Service access.`

`get_private_developer_sales`

- Title: `Get private developer sales`
- Description: `Get URA Data Service developer sales records for private residential projects from the past 3 years, including launched/sold counts and lowest, median, and highest price PSF. Use for new launch/developer-sales context, not resale comparable analysis.`

### 6.1 `list_housing_sources`

Purpose:
Show the agent what data sources exist and whether they are currently available.

Input:

```ts
{
  category?: "all" | "hdb" | "cea" | "ura" | "bca" | "sla" | "cpf";
  source_keys?: SourceKey[];
  include_fields?: boolean; // default false
  include_enum_values?: boolean; // default false
  include_examples?: boolean; // default false
  include_unavailable?: boolean; // default true
}
```

Output data:

```ts
{
  sources: Array<{
    source_key: string;
    category: string;
    display_name: string;
    description: string;
    backend: "data_gov_sg" | "ura_data_service";
    collection_id?: string;
    dataset_ids?: string[];
    ura_service?: string;
    availability_status: "available" | "degraded" | "unavailable";
    validation_status: "unknown" | "ok" | "warning" | "unavailable";
    requires_maintained_distribution: boolean;
    fields?: FieldCatalogEntry[];
    caveats: string[];
    next_action?: string;
  }>;
}
```

Field catalog:

```ts
type FieldCatalogEntry = {
  name: string;
  type: "string" | "number" | "boolean" | "month" | "quarter";
  filterable: boolean;
  operators: Array<"eq" | "in" | "contains" | "gte" | "lte">;
  sortable: boolean;
  default_selected?: boolean;
  compact_priority?: number; // lower numbers appear first in default compact rows
  enum_values?: string[];
  aliases?: string[];
  examples?: unknown[];
};
```

Filter expression:

```ts
type FilterPrimitive = string | number | boolean;

type FilterCondition =
  | FilterPrimitive
  | FilterPrimitive[]
  | {
      op: "eq" | "in" | "contains" | "gte" | "lte";
      value: FilterPrimitive | FilterPrimitive[];
    }
  | {
      gte?: string | number;
      lte?: string | number;
    };

type HousingFilters = Record<string, FilterCondition>;
```

Filter UX:

- Plain `field: value` means `eq`.
- Plain `field: [a, b]` means `in`.
- Range filters may use either `{ op: "gte", value }` / `{ op: "lte", value }` or `{ gte, lte }`.
- `contains` is allowed only for fields marked with `contains` in the field catalog.
- Validation errors must name the invalid field/operator and include a corrected `filters` example.

Field catalog UX:

- `list_housing_sources({ source_keys: [...], include_fields: true })` is the canonical way for an agent to discover valid filters and operators for a narrow source set.
- Each source should mark normalized helper fields such as `contract_month`, `price_psf`, and `type_of_sale` as filterable where supported.
- Each source must define a default compact field set with `default_selected=true`. Row-returning tools use this set when `select` is omitted.
- Validation errors should point back to this catalog and include a corrected example call.

Recommended compact default for `ura_private_residential_transactions`:

```ts
[
  "project",
  "street",
  "district",
  "market_segment",
  "contract_month",
  "type_of_sale",
  "property_type",
  "area_sqm",
  "price",
  "price_psf",
  "floor_range",
  "tenure"
]
```

UX rules:

- This tool must not perform full network validation.
- It may perform cheap local mode checks.
- URA detailed tools in public mode should appear as unavailable with `next_action`, not fail the whole call.
- If `include_fields=true`, callers should provide `source_keys` or a narrow `category`; `category=all` with all fields is rejected unless `allow_large_catalog=true` is added in a CLI-only workflow.
- MCP v1 does not expose `allow_large_catalog`; agents must narrow discovery calls.
- `enum_values` and `examples` are omitted unless `include_enum_values=true` or `include_examples=true`.

### 6.2 `query_housing_rows`

Purpose:
Generic bounded compact row access for curated sources. This is the main "give the agent base data" tool.

Input:

```ts
{
  source: SourceKey;
  filters?: HousingFilters;
  select?: string[];
  limit?: number; // default 50, max 500
  cursor?: string; // opaque continuation token
  max_pages?: number; // default source-specific, max 50
  max_rows_scanned?: number; // default source-specific, max 20000
  sort?: {
    field: string;
    direction?: "asc" | "desc";
  };
  include_raw?: boolean; // default false
}
```

Output data:

```ts
{
  rows: Record<string, unknown>[];
}
```

Behavior:

- Validate `source`, filter keys, selected fields, and limit.
- Push exact filters to backend where possible.
- Apply range/fuzzy filters locally under scan contract.
- Return normalized compact fields by default.
- Include raw backend fields only when `include_raw=true`.
- If `select` is omitted, use the source's default compact field set.
- Include `next_cursor` if continuation is possible.

Scan metadata:

- `rows_returned`
- `rows_scanned`
- `pages_scanned` or `batches_scanned`
- `backend_total` where available
- `complete`
- `truncated`

### 6.3 `aggregate_housing_rows`

Purpose:
Perform bounded local aggregation over curated sources.

Input:

```ts
{
  source: SourceKey;
  filters?: HousingFilters;
  operation: "count" | "group_count" | "top_n_by_count" | "numeric_summary";
  group_by?: string[];
  value_field?: string;
  top_n?: number; // default 10, max 50
  limit_rows_scanned?: number; // default 5000, max 20000
  cursor?: string; // continue a partial aggregation scan
  allow_partial?: boolean; // default false
}
```

Output data:

```ts
{
  operation: string;
  result: Array<Record<string, unknown>> | Record<string, unknown>;
}
```

Completeness:

- `complete=true` only if all matching backend rows were scanned.
- `top_n_by_count` refuses partial rankings unless `allow_partial=true`.
- Numeric summaries over partial scans are labeled sample summaries.
- If a scan cap is reached, return `next_cursor` when the aggregation can be resumed with the same filters and grouping.
- Resumed aggregations must merge accumulator state from the opaque cursor; agents must not reconstruct accumulator state in prompt context.

### 6.4 `find_hdb_resale_comparables`

Input:

```ts
{
  town?: string;
  flat_type?: string;
  block?: string;
  street_name?: string;
  storey_range?: string;
  from?: string; // YYYY-MM
  to?: string; // YYYY-MM
  min_floor_area_sqm?: number;
  max_floor_area_sqm?: number;
  min_price?: number;
  max_price?: number;
  limit?: number; // default 30, max 300
  cursor?: string;
  select?: string[];
  include_raw?: boolean; // default false
  output_mode?: "rows" | "summary" | "both"; // default "both"
}
```

Output data:

```ts
{
  rows: HdbResaleRow[];
  summary: (NumericSummary & SummaryMeta) | null;
}
```

### 6.5 `find_hdb_rental_comparables`

Input:

```ts
{
  town?: string;
  flat_type?: string;
  block?: string;
  street_name?: string;
  from?: string; // YYYY-MM
  to?: string; // YYYY-MM
  min_rent?: number;
  max_rent?: number;
  limit?: number; // default 30, max 300
  cursor?: string;
  select?: string[];
  include_raw?: boolean; // default false
  output_mode?: "rows" | "summary" | "both"; // default "both"
}
```

Output:

```ts
{
  rows: HdbRentalRow[];
  summary: (NumericSummary & SummaryMeta) | null;
}
```

### 6.6 `lookup_hdb_block_profile`

Input:

```ts
{
  block: string;
  street: string;
}
```

Output:

```ts
{
  matches: HdbBlockProfileRow[];
}
```

### 6.7 `lookup_cea_salesperson`

Input:

```ts
{
  registration_no?: string;
  salesperson_name?: string;
  estate_agent_name?: string;
  limit?: number; // default 20, max 100
  cursor?: string;
  select?: string[];
  include_raw?: boolean; // default false
}
```

Output:

```ts
{
  matches: Array<{
    salesperson_name: string;
    registration_no: string;
    registration_start_date: string;
    registration_end_date: string;
    estate_agent_name: string;
    estate_agent_license_no: string;
    match_type: "registration_exact" | "name_exact" | "name_contains" | "agency_contains";
    ambiguous: boolean;
    confidence: "high" | "medium" | "low";
    raw?: Record<string, unknown>;
  }>;
}
```

UX rules:

- `registration_no` is the primary identifier.
- Name-only matches are ambiguous if more than one row matches.
- Do not full-scan by default for fuzzy names.

### 6.8 `query_cea_transactions`

Input:

```ts
{
  salesperson_reg_num?: string;
  salesperson_name?: string;
  town?: string;
  property_type?: "HDB" | "PRIVATE";
  transaction_type?: "RESALE" | "RENTAL" | "NEW SALE" | "SUB SALE";
  represented?: string;
  district?: string;
  general_location?: string;
  from?: string; // YYYY-MM, normalized from MMM-YYYY
  to?: string; // YYYY-MM
  limit?: number; // default 50, max 500
  cursor?: string;
  select?: string[];
  include_raw?: boolean; // default false
  summarize?: boolean; // default false
}
```

Output:

```ts
{
  rows: CeaTransactionRow[];
  summary?: {
    meta: SummaryMeta;
    by_represented?: Record<string, number>;
    by_transaction_type?: Record<string, number>;
    by_town?: Record<string, number>;
  };
}
```

## 7. Private Residential Tools

### 7.1 `find_private_residential_sale_comparables`

Purpose:
Find detailed URA private residential sale transaction rows from the past 5 years.

This is a core v1 tool.

Input:

```ts
{
  project?: string;
  street?: string;
  district?: string; // "04", "10", "19"
  market_segment?: "CCR" | "RCR" | "OCR";

  property_type?:
    | "Condominium"
    | "Apartment"
    | "Executive Condominium"
    | "Terrace"
    | "Semi-detached"
    | "Detached"
    | "Strata Terrace"
    | "Strata Semidetached"
    | "Strata Detached"
    | string;

  type_of_sale?: "new_sale" | "sub_sale" | "resale";

  from?: string; // YYYY-MM
  to?: string; // YYYY-MM

  min_area_sqm?: number;
  max_area_sqm?: number;
  min_price?: number;
  max_price?: number;
  min_price_psf?: number;
  max_price_psf?: number;
  min_price_psm?: number;
  max_price_psm?: number;

  floor_range?: string; // e.g. "01-05"

  limit?: number; // default 30, max 300
  cursor?: string; // opaque continuation token
  max_batches?: number; // default 4
  select?: string[];
  include_raw?: boolean; // default false
  output_mode?: "rows" | "summary" | "both"; // default "both"
}
```

Output data:

```ts
{
  rows: Array<{
    project: string;
    street: string;
    market_segment: "CCR" | "RCR" | "OCR" | string;
    district: string;
    contract_month: string; // YYYY-MM
    contract_date_raw: string; // mmyy
    type_of_sale: "new_sale" | "sub_sale" | "resale" | string;
    type_of_sale_code: "1" | "2" | "3" | string;
    property_type: string;
    tenure: string;
    type_of_area: string;
    floor_range: string;
    area_sqm: number | null;
    price: number | null;
    nett_price: number | null;
    price_psm: number | null;
    price_psf: number | null;
    no_of_units: number | null;
    x: number | null;
    y: number | null;
    source: "URA Data Service PMI_Resi_Transaction";
    batch: number;
    raw?: Record<string, unknown>;
  }>;
  summary: {
    meta: SummaryMeta;
    price?: NumericSummary;
    price_psf?: NumericSummary;
    area_sqm?: NumericSummary;
    sample_size: number;
    by_type_of_sale: Record<string, number>;
    by_property_type: Record<string, number>;
    by_district: Record<string, number>;
  };
}
```

Agent UX:

- If the user gives only `project`, the tool should work.
- If the user gives `district`, scan only the relevant URA batch when possible.
- If the user gives no narrowing filters, reject with `VALIDATION_ERROR` and ask for at least one of `project`, `street`, `district`, `market_segment`, or a tight date/price/area range.
- Return caveat: "Public URA transaction records only; not valuation advice. Coordinates are property-level, not unit-level. No unit number is provided."
- If `next_cursor` is returned, the agent can call the same tool with only `cursor` plus the same original filters, or with `cursor` alone if the cursor encodes the original filters.

Batch mapping:

- Batch 1: postal districts 01-07
- Batch 2: postal districts 08-14
- Batch 3: postal districts 15-21
- Batch 4: postal districts 22-28

Normalization:

- `typeOfSale`: `1 -> new_sale`, `2 -> sub_sale`, `3 -> resale`.
- `contractDate` mmyy:
  - infer century from URA 5-year coverage window;
  - normalize to `YYYY-MM`.
- `price_psm = price / area_sqm`.
- `price_psf = price / (area_sqm * 10.7639104167)`.

### 7.2 `find_private_residential_rental_contracts`

Input:

```ts
{
  project?: string;
  street?: string;
  district?: string;
  property_type?: string;
  bedrooms?: number;
  from?: string; // YYYY-Qn
  to?: string; // YYYY-Qn
  min_area_sqm?: number;
  max_area_sqm?: number;
  min_rent?: number;
  max_rent?: number;
  limit?: number; // default 30, max 300
  cursor?: string; // opaque continuation token
  select?: string[];
  include_raw?: boolean; // default false
  output_mode?: "rows" | "summary" | "both"; // default "both"
}
```

Output:

```ts
{
  rows: Record<string, unknown>[];
  summary: {
    meta: SummaryMeta;
    rent?: NumericSummary;
    rent_psf?: NumericSummary;
    sample_size: number;
  };
}
```

UX:

- If `from/to` are omitted, default to the latest known quarter or latest 4 quarters, depending on API ergonomics.
- A single `--quarter YYYY-Qn` CLI flag maps to `from=to=YYYY-Qn`.

### 7.3 `get_private_residential_rental_medians`

Input:

```ts
{
  project?: string;
  district?: string;
  from?: string; // YYYY-Qn
  to?: string; // YYYY-Qn
  limit?: number; // default 50, max 500
  cursor?: string;
  select?: string[];
  include_raw?: boolean; // default false
}
```

Output:

```ts
{
  rows: Array<{
    project: string;
    street: string;
    district: string;
    ref_period: string; // YYYY-Qn
    psf25: number | null;
    median: number | null;
    psf75: number | null;
    x: number | null;
    y: number | null;
    raw?: Record<string, unknown>;
  }>;
}
```

### 7.4 `get_private_developer_sales`

Input:

```ts
{
  project?: string;
  district?: string;
  market_segment?: "CCR" | "RCR" | "OCR";
  ref_period?: string; // YYYY-MM or raw mmyy accepted
  limit?: number; // default 50, max 500
  cursor?: string;
  select?: string[];
  include_raw?: boolean; // default false
}
```

Output:

```ts
{
  rows: Array<{
    project: string;
    street: string;
    developer: string;
    district: string;
    market_segment: string;
    ref_period: string;
    lowest_price_psf: number | null;
    median_price_psf: number | null;
    highest_price_psf: number | null;
    units_available: number | null;
    launched_to_date: number | null;
    sold_to_date: number | null;
    launched_in_month: number | null;
    sold_in_month: number | null;
    raw?: Record<string, unknown>;
  }>;
}
```

## 8. URA Data Service Client

### 8.1 URA Token Generation Contract

Direct URA endpoint:

```http
GET https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1
AccessKey: <maintainer access key>
```

Rules:

- Method is `GET`.
- Required header is `AccessKey`.
- Do not send the access key in query string.
- Do not log the access key.
- Timeout should be short and bounded.
- Use this direct flow only when the process legitimately has an URA `AccessKey` from `URA_ACCESS_KEY` or an explicitly authorized maintained provider.
- If maintained mode uses a token broker/proxy, `UraClient.getToken()` calls the broker instead; the local package never receives the maintainer's URA `AccessKey`.

Expected success response:

```json
{
  "Result": "<daily token>",
  "Status": "Success",
  "Message": ""
}
```

Parsing:

- Treat `Status === "Success"` and non-empty string `Result` as success.
- Store `Result` as the daily token.
- Preserve `Message` only for redacted diagnostics.

Failure mapping:

- HTTP 401/403 or JSON status/message indicating invalid access key:
  `URA_AUTH_FAILED`, `recoverable=false`.
- HTTP 429 or rate-limit message:
  `URA_RATE_LIMITED`, `recoverable=true`, include `retry_after_seconds` if available.
- HTTP 5xx, timeout, DNS/TLS/network failure:
  `URA_SERVICE_UNAVAILABLE`, `recoverable=true`.
- JSON parse failure or missing `Result` on a nominal success:
  `URA_SERVICE_UNAVAILABLE`, `recoverable=true`, with redacted details.

Maintained-mode smoke requirement:

```bash
sg-housing private sales --project "TURQUOISE" --limit 5 --json
```

In `maintained` mode this command must succeed without `URA_ACCESS_KEY` being set by the user. If it fails because no approved maintained credential strategy is available, the build is misclassified and must report `distribution_mode=development` or `public`, not `maintained`.

### 8.2 Runtime Client

Token lifecycle:

```ts
class UraClient {
  getToken(): Promise<string>;
  invoke(service: string, params: Record<string, string | number>): Promise<unknown>;
}
```

Rules:

- Lazy token generation.
- Store token and token generation Singapore date in memory only.
- Refresh token on Singapore-date rollover.
- On auth/token failure:
  - clear token;
  - get new token;
  - retry original request once.
- Single-flight token refresh across concurrent calls.
- Redact `AccessKey` and `Token` in logs/errors.

Service calls:

```ts
invoke("PMI_Resi_Transaction", { batch: 1 })
invoke("PMI_Resi_Rental", { refPeriod: "24q1" })
invoke("PMI_Resi_Rental_Median", {})
invoke("PMI_Resi_Developer_Sales", { refPeriod: "0126" })
```

## 9. Scan Contracts

Cursor format:

All cursors are opaque base64url JSON tokens. Clients and agents must not construct them manually.

URA cursor payload:

```ts
type UraCursorPayload = {
  backend: "ura_data_service";
  tool:
    | "find_private_residential_sale_comparables"
    | "find_private_residential_rental_contracts"
    | "get_private_residential_rental_medians"
    | "get_private_developer_sales";
  source_key: string;
  filters_hash: string;
  original_filters: Record<string, unknown>;
  candidate_batches?: number[];
  current_batch?: number;
  project_index?: number;
  transaction_index?: number;
  ref_periods?: string[];
  current_ref_period_index?: number;
  rows_scanned: number;
  rows_returned: number;
  scan_cap?: {
    max_batches?: number;
    max_rows_scanned?: number;
    limit?: number;
  };
};
```

Aggregation cursor payload:

```ts
type AggregateCursorPayload = {
  backend: "data_gov_sg" | "ura_data_service";
  tool: "aggregate_housing_rows";
  source_key: string;
  filters_hash: string;
  original_filters: HousingFilters;
  operation: "count" | "group_count" | "top_n_by_count" | "numeric_summary";
  group_by?: string[];
  value_field?: string;
  accumulator: Record<string, unknown>;
  backend_position: Record<string, unknown>;
  rows_scanned: number;
  scan_cap: {
    limit_rows_scanned: number;
  };
};
```

Cursor validation:

- A cursor may only continue the same tool and same original filters.
- If the caller provides filters that do not match `filters_hash`, return `VALIDATION_ERROR`.
- The error `next_action` should say: "Use the cursor by itself or repeat the same filters from the original call."
- Cursor payloads must not include credentials or tokens.
- Aggregation cursors may include accumulator state but must still obey the hard MCP response budget.

For data.gov.sg paged sources:

- Fetch pages until accepted rows reach `limit`, backend exhausts, or scan cap is reached.
- Return `next_cursor` if continuation is possible.

For URA batch sources:

- Determine candidate batches from `district` when possible.
- Otherwise scan batches 1 to 4 in order.
- Apply project/street/market segment filters at project level.
- Flatten nested transaction arrays.
- Apply transaction-level filters.
- For row output, stop returning rows when accepted rows reach `limit`; include `next_cursor` when more candidate rows may exist.
- For `output_mode="summary"` or `aggregate_housing_rows`, scan all candidate batches/periods within scan caps and return no large row payload.
- For `output_mode="both"`, compute summary over the scanned candidate set where feasible, but only return the bounded row page.

Completeness:

- `complete=true` only when every candidate page/batch/period was scanned.
- `truncated=true` when stopped due to cap before backend exhaustion.
- Private sale comparable row queries can return useful samples when incomplete, but summaries must be labeled partial.

## 10. CLI Mapping

### 10.1 Help Contract

The CLI must provide useful `--help` at every level. Help is part of the user experience and should be tested.

Required help commands:

```bash
sg-housing --help
sg-housing sources --help
sg-housing rows --help
sg-housing aggregate --help
sg-housing hdb --help
sg-housing hdb resale --help
sg-housing hdb rent --help
sg-housing hdb block --help
sg-housing cea --help
sg-housing cea salesperson --help
sg-housing cea transactions --help
sg-housing private --help
sg-housing private sales --help
sg-housing private rentals --help
sg-housing private rental-medians --help
sg-housing private developer-sales --help
sg-housing doctor --help
sg-housing mcp --help
```

Global help must show:

- one-line product description;
- active distribution mode if cheaply known without network calls;
- command groups: `sources`, `rows`, `aggregate`, `hdb`, `cea`, `private`, `doctor`, `mcp`;
- maintenance command: `update-check`;
- examples for the three most common tasks:
  - HDB resale comparables;
  - private sale comparables;
  - CEA salesperson/transaction analysis;
- note that detailed URA private tools use the maintained proxy by default and do not require end-user credentials.

Subcommand help must show:

- purpose;
- required and optional flags;
- accepted date format;
- default and max `--limit`;
- whether the command may return partial results;
- source/caveat summary;
- at least two copy-paste examples.

Help output rules:

- `--help` always writes human-readable text to stdout and exits `0`.
- `--help` must not perform network calls.
- `--help` must not print credentials or tokens.
- `--json` is ignored when `--help` is present.
- Unknown command or invalid flags should show a concise error plus "Run `sg-housing <command> --help`".

Example `sg-housing private sales --help` content should include:

```text
Find detailed URA private residential sale transactions from the past 5 years.

Examples:
  sg-housing private sales --project "TURQUOISE" --type-of-sale resale --from 2022-01 --limit 30
  sg-housing private sales --district 04 --property-type Condominium --min-area-sqm 100 --max-area-sqm 140
  sg-housing private sales --market-segment CCR --from 2024-01 --min-price-psf 2000 --limit 30 --select project,district,contract_month,price_psf

Caveats:
  Not valuation advice. URA does not provide unit numbers; coordinates are project-level.
  Detailed URA tools use the maintained proxy by default and do not require end-user credentials.
```

### 10.2 Commands

Generic:

```bash
sg-housing rows --source SOURCE --filter key=value --limit 50 --select field_a,field_b
sg-housing rows --source SOURCE --filters-json '{"key":"value"}'
sg-housing aggregate --source SOURCE --operation top_n_by_count --group-by a,b --top-n 10
```

Private sales:

```bash
sg-housing private sales --project "TURQUOISE" --type-of-sale resale --from 2022-01 --limit 30
sg-housing private sales --district 04 --property-type Condominium --min-area-sqm 100 --max-area-sqm 140 --limit 30
sg-housing private sales --market-segment CCR --from 2024-01 --min-price-psf 2000 --limit 30 --select project,district,contract_month,price_psf
```

Private rentals:

```bash
sg-housing private rentals --project "THE MINTON" --from 2024-Q1 --to 2026-Q1
sg-housing private rentals --project "120 GRANGE" --quarter 2026-Q1
```

Doctor:

```bash
sg-housing doctor --json
sg-housing doctor --mcp --json
sg-housing update-check --json
sg-housing update-check --force --json
```

CLI output:

- JSON to stdout.
- Logs/warnings to stderr.
- `--table` and `--csv` optional for humans.

## 11. Claude Agent Usage Patterns

Question:
"Find recent private condo resale comparables for TURQUOISE."

Expected tool call:

```json
{
  "project": "TURQUOISE",
  "type_of_sale": "resale",
  "property_type": "Condominium",
  "limit": 30,
  "select": ["project", "district", "contract_month", "area_sqm", "price", "price_psf", "floor_range"]
}
```

Question:
"CCR 最近一年 2000 psf 以上的 condo 成交有哪些？"

Expected tool call:

```json
{
  "market_segment": "CCR",
  "property_type": "Condominium",
  "from": "2025-06",
  "min_price_psf": 2000,
  "limit": 30,
  "select": ["project", "district", "contract_month", "price", "price_psf", "area_sqm"]
}
```

Question:
"Ang Mo Kio 哪个中介 HDB resale 最多？"

Expected tool call:

```json
{
  "source": "cea_residential_transactions",
  "filters": {
    "town": "ANG MO KIO",
    "property_type": "HDB",
    "transaction_type": "RESALE"
  },
  "operation": "top_n_by_count",
  "group_by": ["salesperson_reg_num", "salesperson_name"],
  "top_n": 10
}
```

Agent answer rules:

- Cite source and coverage.
- Mention if result is partial.
- Do not call comparable summaries valuation.
- For URA private sales, state that no unit number is provided and coordinates are project-level.
- Do not fetch repeated row pages just to count or rank; use `aggregate_housing_rows`.
- When evidence rows are needed, fetch the smallest useful page and narrow `select`.
- If the user asks for a broad list, return a summarized answer and mention that more rows can be fetched with `next_cursor`.

## 12. Validation and Doctor

`doctor` output:

```ts
{
  ok: boolean;
  status: "ok" | "degraded" | "unavailable";
  distribution_mode: "public" | "maintained" | "development";
  checks: Array<{
    name: string;
    status: "ok" | "degraded" | "unavailable";
    message: string;
    next_action?: string;
  }>;
}
```

Checks:

- Node/runtime version.
- package version.
- distribution mode.
- data.gov.sg metadata reachability.
- data.gov.sg row query reachability.
- URA access key availability by mode.
- URA token generation only when maintained/development credentials exist.
- MCP stdout/stderr hygiene for `doctor --mcp`.
- npm package update status, cached for 24 hours and disabled by `SG_HOUSING_DISABLE_UPDATE_CHECK=1`.

Update-check output:

```ts
{
  package_name: "sg-housing-data";
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  checked_at: string | null;
  source: "disabled" | "cache" | "network" | "error";
  message: string;
  next_action: string | null;
}
```

The MCP server exposes `check_package_update` for explicit agent maintenance workflows. `sg-housing mcp` must not perform startup update checks or print upgrade prompts because stdio must remain protocol-clean.

## 13. Implementation Priority

P0:

- Distribution mode detection.
- Credential provider with approved maintained strategy and `URA_ACCESS_KEY` override.
- URA token lifecycle.
- Source registry field catalog with compact default field sets.
- `query_housing_rows`.
- `aggregate_housing_rows`.
- Strict MCP response-budget enforcement: row limits, `select`, `include_raw=false`, `truncated`, and `next_cursor`.
- `find_private_residential_sale_comparables`.
- Shared response/error envelope.
- `doctor`.
- Precise MCP tool titles/descriptions for every registered tool.
- CLI `--help` for global command and every subcommand.

P1:

- HDB resale/rental tools.
- CEA salesperson/transactions tools.
- Private rental contracts.
- Tests that validate MCP descriptions mention source, output style, and caveat.
- Tests that validate `--help` exits 0 without network calls.
- Tests that validate row-returning tools never exceed MCP row/size budgets and never include `raw` unless requested.

P2:

- Rental medians.
- Developer sales.
- data.gov.sg URA summary tools.
