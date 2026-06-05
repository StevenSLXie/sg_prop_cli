# Singapore Housing Data CLI + Local MCP Spec

Date: 2026-06-05
Status: Draft v0.2
Primary client: Claude CLI using a local stdio MCP server

## 1. Goal

Build a local CLI and local MCP server that wraps relevant data.gov.sg housing/property datasets into agent-friendly tools.

The first target user is a Claude CLI user who wants to ask practical Singapore housing questions, such as:

- "Find recent HDB resale comparables near Ang Mo Kio Ave 4."
- "What is the rental range for 4-room HDB flats in Queenstown?"
- "Is this CEA salesperson active, and what transactions have they handled?"
- "In Ang Mo Kio HDB resale, which salesperson appears most often in CEA records?"
- "Give me source rows for CEA HDB resale transactions in Yishun since 2024 so I can analyze agent activity."

The important product decision: this is not a one-to-one mirror of data.gov.sg APIs. It is a curated data access layer that exposes both:

- domain tools for common property workflows; and
- low-level, bounded row/query tools so an agent can compose its own analysis.

## 2. Non-Goals for v1

- No persistent local cache, database, or index.
- No hosted service.
- No UI.
- No geospatial point-in-polygon engine in v1.
- No guarantee that every housing-related collection on data.gov.sg is exposed.
- No financial, legal, or valuation advice. Outputs should cite public data and caveats.

Clarification on cache:

- "No cache" means no persistent local storage and no user-query history.
- Short-lived in-process metadata/schema caching is allowed for the lifetime of the MCP process to reduce duplicate metadata calls and rate-limit pressure.
- Row data should not be persisted in v1.

## 3. Technical Stack Decision

Recommended stack: Node.js + TypeScript.

Rationale:

- Claude CLI MCP fit: MCP's TypeScript SDK is first-party, mature, and works naturally with stdio.
- One runtime for CLI and MCP: the same TypeScript modules can power `sg-housing` and `sg-housing-mcp`.
- Low deployment friction: users can run it with `npx`, global npm install, or local `node dist/mcp.js`.
- Good enough data processing: v1 mostly does HTTP calls, pagination, filtering, simple group/count/sort, and JSON output. Node is sufficient.
- Strong tool schemas: TypeScript + Zod maps cleanly to MCP input validation.

Alternatives considered:

- Python: better for heavy analytics and geospatial work, but local MCP packaging and Claude CLI setup are usually more uneven than a Node stdio server. Python becomes more attractive in v2 if we add DuckDB/GeoPandas/Shapely.
- Go: good static binary story, but slower iteration and more MCP/tooling friction for this stage.
- Rust: not justified for a public-data wrapper v1.

Decision:

- Use TypeScript for v1.
- Keep a clean boundary around the data client so a future Python/DuckDB/geospatial backend can be added without changing MCP tool names.

## 4. Data Source Principles

All data comes live from data.gov.sg.

Use these public API surfaces:

- Collection metadata:
  `https://api-production.data.gov.sg/v2/public/api/collections/{collectionId}/metadata?withDatasetMetadata=true`
- Dataset rows:
  `https://api-production.data.gov.sg/v2/public/api/datasets/{datasetId}/list-rows`
- Filtered row search where exact filters are needed:
  `https://data.gov.sg/api/action/datastore_search?resource_id=...&filters=...`
- Dataset download API can be added later for bulk operations, but v1 should avoid it unless needed.
- URA Data Service API for detailed private residential transaction/rental data:
  `https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1`
  - Requires an URA `AccessKey` and a daily `Token`.
  - Credentials must be provided through an approved credential strategy; do not assume an extractable shared key can be redistributed safely.
  - The MCP process exchanges the access key for a daily token and keeps that token in memory only.

No persistent cache means:

- every tool call hits data.gov.sg;
- every tool must expose `limit`;
- every tool must return `next_cursor` or enough information to continue;
- every result should include source dataset IDs and last-updated metadata when available;
- expensive full-table operations must require narrow filters or explicit `max_pages`.
- metadata calls may use short-lived in-process caching, but results must still expose the live `lastUpdatedAt` values returned by data.gov.sg when available.

URA credential policy:

- Product goal: end users should have the smoothest possible experience, but credential handling must comply with URA API terms and keep access control credentials secure and confidential.
- A redistributable package must not treat an extractable shared `AccessKey` as the default sustainable design. Embedding a real URA key in an npm package, even a private package, is allowed only if the maintainer has explicit written permission or the distribution is an internal controlled environment where every recipient is authorized under the key holder's account.
- Supported v1 credential strategies, in priority order:
  - `URA_ACCESS_KEY` environment fallback for forked/internal builds where no maintained proxy URL is configured;
  - a maintainer-operated token broker/proxy that keeps the URA `AccessKey` server-side and returns only scoped short-lived access to this client;
  - an embedded maintained key only for explicitly authorized controlled distributions.
- The CLI/MCP should hide credential mechanics from normal users when an approved maintained strategy is available.
- The public open-source repo must not commit a real URA access key. It may contain a placeholder credential provider and build-time checks that fail if a public build accidentally includes a real key.
- If the URA key is missing, invalid, revoked, or rate-limited, only URA detailed private residential tools become unavailable; HDB, CEA, and data.gov.sg-backed URA summary tools should still work.
- Tool responses must not print the access key or token. Logs must redact both.
- If an embedded maintained key is used under explicit authorization, the package should still be treated as extractable and low-volume; rotate the key immediately if abuse, leakage, or quota pressure appears.

Distribution modes:

- `public`: public repo/public npm package. HDB, CEA, and data.gov.sg-backed URA summary tools work without credentials. URA Data Service detailed tools are hidden by default from convenience prompts and shown as `unavailable` in `sources`/`doctor` with a friendly message.
- `maintained`: distribution configured with an approved maintained credential strategy: token broker/proxy, authorized embedded key, or managed local deployment. Detailed URA Data Service tools work out of the box only when that strategy is healthy.
- `development`: source checkout. Detailed URA Data Service tools still use the maintained default proxy when configured; direct `URA_ACCESS_KEY` is only a fallback for forked/internal builds without a proxy URL.
- The active mode must be included in `sources`, `doctor`, CLI errors, and MCP error payloads as `distribution_mode`.
- `npx -y sg-housing-data mcp` is only guaranteed to provide detailed URA tools if it resolves to a maintained distribution with an approved credential strategy. Public `npx` must not be advertised as supporting detailed URA tools out of the box.

URA token lifecycle:

- Treat the URA `AccessKey` as a long-lived credential, but do not assume it is permanently valid; it may be revoked or rotated by URA or the maintainer.
- Treat the URA `Token` as a daily short-lived credential generated from the access key.
- The MCP/CLI should lazily generate a token on the first URA Data Service call, not during startup unless a health check asks for it.
- Store the generated token in process memory with the local Singapore date on which it was created.
- Before every URA Data Service request:
  - if no token exists, generate one;
  - if the stored token was generated on a prior Singapore date, generate a fresh token;
  - otherwise reuse the in-memory token.
- If a URA Data Service request fails with an authentication/token-expiry style response, invalidate the in-memory token, generate a new token, and retry the original request once.
- If the retry fails, return a structured URA auth/service error.
- Token generation should be single-flight inside a process: concurrent URA calls should wait on one token refresh rather than creating multiple tokens at once.
- Never persist the token to disk.

## 5. Dataset Registry v1

The implementation should maintain a static registry of curated dataset IDs and field mappings. The registry is not a cache; it is a source map.

Registry validation is required:

- `sg-housing mcp` must start without live network validation. Claude CLI startup should be fast and should not fail because data.gov.sg or URA is temporarily unavailable.
- Validation is lazy per source/tool during normal use.
- `list_housing_sources` should show validation status: `unknown | ok | warning | unavailable`, plus the last validation error when known.
- `sg-housing doctor` and `sg-housing validate-registry` perform explicit full validation.
- Verify that expected dataset IDs are still listed under the expected collection, unless the source is explicitly marked `legacy_detached`.
- Verify required fields by sampling one row or schema metadata.
- If a required source fails validation, mark that source unavailable and return a clear MCP/CLI error for tools that depend on it.
- Tests should include a registry validation command so schema drift is caught before release.

### 5.1 HDB Core

Resale transaction details:

- Collection: `189 Resale Flat Prices`
- Current dataset: `d_8b84c4ee58e3cfc0ece0d773c8ca6abc`
- Historical datasets:
  - `d_43f493c6c50d54243cc1eab0df142d6a`
  - `d_2d5ff9ea31397b66239f245f57751537`
  - `d_ebc5ab87086db484f88045b47411ebc5`
  - `d_ea9ed51da2787afaf8e51f827c304208`
- Canonical fields:
  `month`, `town`, `flat_type`, `block`, `street_name`, `storey_range`,
  `floor_area_sqm`, `flat_model`, `lease_commence_date`, `remaining_lease`,
  `resale_price`
- Caveat: pre-March 2012 uses approval date; March 2012 onward uses registration date.

Median resale by town/flat type:

- Collection: `157`
- Dataset: `d_b51323a474ba789fb4cc3db58a3116d4`
- Fields: `quarter`, `town`, `flat_type`, `price`

Median rent by town/flat type:

- Collection: `156`
- Dataset: `d_23000a00c52996c55106084ed0339566`
- Fields: `quarter`, `town`, `flat_type`, `median_rent`

HDB rental transaction rows:

- Collection: `166`
- Dataset: `d_c9f57187485a850908655db0e8cfe651`
- Fields: `rent_approval_date`, `town`, `block`, `street_name`, `flat_type`, `monthly_rent`

HDB block/property profile:

- Collection: `150`
- Dataset: `d_17f5382f26140b1fdae0ba2ef6239d2f`
- Fields include:
  `blk_no`, `street`, `max_floor_lvl`, `year_completed`, `residential`,
  `commercial`, `total_dwelling_units`, sold/rental counts by flat type.

### 5.2 CEA Core

Active salesperson lookup:

- Collection: `54`
- Dataset: `d_07c63be0f37e6e59c07a4ddc2fd87fcb`
- Fields:
  `salesperson_name`, `registration_no`, `registration_start_date`,
  `registration_end_date`, `estate_agent_name`, `estate_agent_license_no`

Residential salesperson transaction records:

- Collection: `55`
- Dataset: `d_ee7e46d3c57f7865790704632b0aef71`
- Fields:
  `salesperson_name`, `transaction_date`, `salesperson_reg_num`,
  `property_type`, `transaction_type`, `represented`, `town`, `district`,
  `general_location`
- Important: this dataset is especially useful for agent-composed analysis. Do not only expose "lookup by name"; expose filtered row access and grouping.

### 5.3 Private Residential / URA Core

Detailed private residential transactions:

- Source: URA Data Service API
- Service: `PMI_Resi_Transaction`
- Endpoint:
  `GET https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1?service=PMI_Resi_Transaction&batch={1..4}`
- Authentication:
  - `AccessKey` header
  - `Token` header, generated daily from `insertNewToken/v1`
- Coverage: past 5 years.
- Update frequency: end of day every Tuesday and Friday.
- Batch behavior:
  - Data is split into 4 batches by postal district.
  - v1 tools should hide batches from the user and expose project/district/market-segment filters.
- Project-level fields:
  `project`, `street`, `marketSegment`, `x`, `y`
- Transaction fields:
  `contractDate`, `area`, `price`, `nettPrice`, `propertyType`, `typeOfArea`,
  `tenure`, `floorRange`, `typeOfSale`, `district`, `noOfUnits`
- Important caveats:
  - Coordinates are the property/project address location, not the transacted unit location.
  - No unit number is provided.
  - `contractDate` is `mmyy`.
  - `typeOfSale`: `1 = New Sale`, `2 = Sub Sale`, `3 = Resale`.
  - Records older than 5 years may be modified/aborted; URA advises retaining the latest 5-year set for accuracy.

Detailed private residential rental contracts:

- Source: URA Data Service API
- Service: `PMI_Resi_Rental`
- Coverage: past 5 years.
- Update frequency: end of day every 15th of the month, or next working day.
- Query parameter: `refPeriod`, in `yyqq` format.
- Fields to expose after normalization should include project, street, district, property type, bedroom count where available, area, rent, lease date/reference period, and coordinates.
- This is important for private-rental comparables, but transaction-sale records are higher priority.

Private non-landed median rentals by name:

- Source: URA Data Service API
- Service: `PMI_Resi_Rental_Median`
- Coverage: past 3 years.
- Fields:
  `project`, `street`, `x`, `y`, `rentalMedian[]`, `district`, `refPeriod`,
  `psf25`, `median`, `psf75`

Developer sales:

- Source: URA Data Service API
- Service: `PMI_Resi_Developer_Sales`
- Coverage: past 3 years.
- Fields:
  `project`, `street`, `developer`, `marketSegment`, `district`, `developerSales[]`,
  `refPeriod`, `medianPrice`, `lowestPrice`, `highestPrice`, `unitsAvail`,
  `launchedToDate`, `soldToDate`, `launchedInMonth`, `soldInMonth`

Non-landed rental benchmark:

- Collection: `1660`
- Dataset: `d_149ac00a2734bb0a03867bbe2ec0e7b0`
- Fields:
  `qtr`, `project_name`, `postal_district`, `25th_percentile`, `median`,
  `75th_percentile`, `rental_contracts`

Private residential transaction volumes:

- Collection: `1658`
- Dataset: `d_7c69c943d5f0d89d6a9a773d2b51f337`
- Fields:
  `quarter`, `type_of_sale`, `sale_status`, `units`

Private property price index:

- Collection: `1676`
- Dataset: `d_97f8a2e995022d311c6c68cfda6d034c`
- Fields:
  `quarter`, `property_type`, `index`

Private residential rental index:

- Collection: `1820`
- Dataset: `d_8e4c50283fb7052a391dfb746a05c853`
- Fields to confirm during implementation via `list-rows`.

### 5.4 Optional v1 / v1.5

- HDB Carpark Information: collection `148`
- HDB Resale Price Index: collection `152`
- HDB resale/rental application volumes: collections `164`, `159`
- BCA MCST: collection `21`
- BCA Green Mark Buildings: collection `18`
- SLA Dwelling Information: collection `1578`

## 6. Data Access Modes

The system should expose three levels of access.

### 6.1 Curated Domain Queries

These answer common user needs with normalized output.

Examples:

- HDB resale comparables
- HDB rental comparables
- HDB town/flat-type median summaries
- HDB block profile lookup
- CEA salesperson lookup
- Private residential transaction comparables
- Private residential rental contract comparables
- Private residential project rental benchmark

### 6.2 Bounded Raw Row Queries

These expose normalized source rows to the agent, with guardrails. They are low-level primitives, but they are still context-budgeted MCP calls, not bulk export APIs.

Examples:

- Return CEA transaction rows filtered by `town=ANG MO KIO`, `property_type=HDB`, `transaction_type=RESALE`, `limit=50`.
- Return HDB resale rows filtered by town, flat type, and date range.
- Return private residential sale transaction rows filtered by project, district, sale type, date, property type, floor range, and area.
- Return private residential rental contract rows filtered by project, district, lease/reference period, property type, bedroom count, area, and rent.
- Return private rental benchmark rows filtered by project name or postal district.

This is the key design response to the "complex query" requirement. The MCP should not try to predict every question. It should let Claude fetch relevant, bounded source rows and then reason over them.

Context budget rules:

- Default row-returning calls should be small enough for direct model inspection.
- Row-returning tools default to normalized compact fields, not full backend payloads.
- Every row-returning tool should expose `limit`, `cursor` where continuation is meaningful, `select`, and `include_raw=false`.
- No MCP tool should return more than 500 rows in one call.
- If a user asks for all records, return the first bounded page with `next_cursor`; do not stream the whole table into context.
- Agents should use `aggregate_housing_rows` for top/count/summary questions, then fetch small evidence pages only when needed.

Shared output-control semantics:

- `select` limits returned normalized fields and should be preferred in examples.
- `include_raw=false` means no backend payload object is included. `include_raw=true` may add a `raw` object per row, but only within strict row and response-size limits.
- `output_mode=rows` returns bounded compact rows and metadata.
- `output_mode=summary` returns stats/group counts and metadata, with no row list unless a tool explicitly documents a tiny sample.
- `output_mode=both` returns bounded compact rows plus compact summary and is the default for comparable tools.
- For broad ranking/count/range questions, tools and docs should steer agents to `aggregate_housing_rows` instead of repeated row-page fetching.

Shared summary metadata:

- Every convenience summary must include `summary_scope`: `returned_rows | scanned_candidates | complete_matching_set`.
- Every convenience summary must include `summary_rows_scanned`, `summary_sample_size`, `summary_complete`, and `summary_truncated`.
- If `summary_complete=false`, labels must say "sample" or "partial"; agent answers must not present the summary as a population statistic.

### 6.3 Lightweight Aggregations

Some aggregations are better done locally before returning to the model, especially when matching row payloads are many.

Supported aggregation operations in v1:

- `count`
- `group_count`
- `top_n_by_count`
- numeric summary: `min`, `max`, `avg`, `median`, `p25`, `p75` for a numeric field

Examples:

- Top salesperson by CEA transaction count in a town.
- Count HDB resale transactions by flat type.
- Median HDB resale price by town and flat type.
- Rental percentile summary for a filtered set.

The agent should still receive enough metadata to explain what was counted.

Aggregation completeness is part of the contract:

- Every aggregation response must include `complete`, `backend_total`, `rows_scanned`, `pages_scanned`, and `truncated`.
- Rank-style results such as `top_n_by_count` must be marked non-authoritative when `complete=false`.
- If `complete=false`, the tool should either refuse to return an authoritative ranking or require an explicit `allow_partial=true` input.
- Results must be scanned in deterministic backend order so repeated partial runs are at least reproducible.
- If a scan cap is reached, return `next_cursor` when the aggregation can continue. The cursor owns accumulator state; agents should not fetch every row page and aggregate inside the prompt.

## 7. MCP Tool Spec

Tool names should be stable and descriptive. Avoid exposing raw data.gov.sg terminology as the main interface.

### 7.1 `list_housing_sources`

Purpose:
List curated datasets available through this MCP server.

Inputs:

- `category?`: `hdb | cea | ura | bca | sla | cpf | all`
- `source_keys?`: one or more exact source keys to inspect
- `include_fields?`: boolean
- `include_enum_values?`: boolean, default false
- `include_examples?`: boolean, default false

Output:

- source key
- collection ID
- dataset IDs
- description
- canonical fields
- caveats
- `distribution_mode`: `public | maintained | development`
- `validation_status`: `unknown | ok | warning | unavailable`
- `availability_status`: `available | degraded | unavailable`
- `requires_maintained_distribution`: boolean for URA Data Service detailed sources
- `next_action` for degraded/unavailable sources

Context guardrail:

- `include_fields=true` should be used with `source_keys` or a narrow `category`.
- MCP should reject `category=all` plus `include_fields=true` because returning every field catalog can pollute context.
- Large enum lists and examples are omitted unless explicitly requested.

### 7.2 `query_housing_rows`

Purpose:
Generic bounded row access for curated datasets. This is the main "give base data to agent" tool.

Inputs:

- `source`: enum, examples:
  - `hdb_resale_transactions`
  - `hdb_rental_transactions`
  - `hdb_median_resale`
  - `hdb_median_rent`
  - `hdb_block_profile`
  - `cea_salespersons`
  - `cea_residential_transactions`
  - `ura_private_residential_transactions`
  - `ura_private_residential_rentals`
  - `ura_private_rental_medians`
  - `ura_private_developer_sales`
  - `ura_non_landed_rental_benchmark`
  - `ura_private_transaction_volume`
  - `ura_private_price_index`
- `filters`: object with source-specific allowed fields. Values may be plain equality values or operator objects:
  - `town: "ANG MO KIO"` means equality
  - `town: ["ANG MO KIO", "BISHAN"]` means `in`
  - `price_psf: { "gte": 2000, "lte": 2600 }` means range
  - `project: { "op": "contains", "value": "MINTON" }` means contains, only when supported by the field catalog
- `select?`: array of field names
- `limit`: default 50, max 500
- `cursor?`: opaque continuation token returned by a previous call
- `max_pages?`: bounded scan cap for locally filtered page sources, default source-specific, max 50
- `max_rows_scanned?`: bounded scan cap for locally filtered row sources, default source-specific, max 20000
- `sort?`: simple sort field and direction where supported
- `include_source?`: boolean, default true
- `include_raw?`: boolean, default false

Behavior:

- Validate source and filter keys.
- Prefer server-side exact filters through `datastore_search` where possible.
- Use `list-rows` for simple page reads.
- Return rows as JSON, not prose.
- If `select` is omitted, return the source's compact default field set.
- Include backend raw fields only when `include_raw=true`; MCP calls should reject or shrink raw responses that would exceed the response budget.
- Include `next_cursor` if more data may exist.
- Include `total` if the backend returns it.
- Include `rows_returned`, `rows_scanned`, `pages_scanned`, `backend`, and `truncated`.

Cursor contract:

- `next_cursor` is an opaque base64url JSON token controlled by this package.
- The token must include backend type, source, dataset ID, original filters, select fields, sort, and either the data.gov.sg `list-rows` cursor or `datastore_search` numeric offset.
- The client should never construct cursors manually.
- A cursor may only continue the same query. If filters/source differ from the cursor payload, reject the request.
- Do not expose raw data.gov.sg cursor strings as the public MCP/CLI cursor format.

Guardrails:

- max 500 rows per MCP call;
- no unfiltered query on large sources unless `limit <= 50`;
- warn if filter is likely too broad;
- preserve raw backend values only behind `include_raw=true`; normalized compact fields are the default.
- exact filters should be pushed to data.gov.sg where supported; range and fuzzy filters may be applied locally, but local filtering must follow the scan contract below.

Scan contract for local filters:

- Continue fetching pages until one of these happens:
  - enough accepted rows have been returned to satisfy `limit`;
  - the backend is exhausted;
  - `max_pages` or `max_rows_scanned` is reached.
- If `max_pages` or `max_rows_scanned` is reached before backend exhaustion, return `truncated=true` and `complete=false`.
- Do not imply that missing rows do not exist when `complete=false`.

### 7.3 `aggregate_housing_rows`

Purpose:
Do local bounded aggregation over a curated source.

Inputs:

- `source`
- `filters`
- `operation`: `count | group_count | top_n_by_count | numeric_summary`
- `group_by?`: one or more field names
- `value_field?`: required for numeric summary
- `limit_rows_scanned`: default 5000, max 20000
- `top_n?`: default 10
- `cursor?`: opaque continuation token for resumable aggregation scans
- `allow_partial?`: default false; required for rank-style partial results

Example:

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

Output:

- aggregation result rows
- rows scanned
- pages scanned
- backend total if available
- `complete`: boolean
- `truncated`: boolean
- truncation warning if scan cap was reached
- source/caveat metadata

Completeness rules:

- `complete=true` only when the filtered backend result set was fully scanned.
- For `count`, `group_count`, and `top_n_by_count`, partial results can materially change the answer.
- If `operation=top_n_by_count` and `complete=false` and `allow_partial` is not true, return an error asking the caller to narrow filters or explicitly accept partial ranking.
- Numeric summaries over partial rows must be labeled as sample summaries, not population summaries.
- If the backend can continue, include `next_cursor`. A resumed call must use the same source, filters, operation, grouping, and value field.

### 7.4 `find_hdb_resale_comparables`

Purpose:
Convenience tool for common resale comparable searches.

Inputs:

- `town?`
- `flat_type?`
- `block?`
- `street_name?`
- `storey_range?`
- `min_month?`
- `max_month?`
- `min_floor_area_sqm?`
- `max_floor_area_sqm?`
- `limit?`
- `select?`
- `include_raw?`: default false
- `output_mode?`: `rows | summary | both`, default `both`

Output:

- rows
- summary stats for `resale_price`
- caveats
- source period and sample size
- explicit disclaimer: public transaction data only; not valuation advice

Implementation note:
Since data.gov.sg exact filters are limited, start with server-side exact filters for `town`, `flat_type`, `block`, `street_name`; apply range filters locally on returned pages. The tool must follow the scan contract in `query_housing_rows`: fetch until `limit` accepted rows, backend exhaustion, or a configured scan cap, then report `complete` and `truncated`.

### 7.5 `find_hdb_rental_comparables`

Purpose:
Find HDB rental transaction rows.

Inputs:

- `town?`
- `flat_type?`
- `block?`
- `street_name?`
- `min_rent_approval_date?`
- `max_rent_approval_date?`
- `limit?`
- `select?`
- `include_raw?`: default false
- `output_mode?`: `rows | summary | both`, default `both`

Output:

- rows
- monthly rent summary
- caveats
- source period and sample size
- explicit disclaimer: public rental transaction data only; not rental valuation advice
- `complete`, `truncated`, `rows_scanned`, and `pages_scanned`

### 7.6 `lookup_hdb_block_profile`

Purpose:
Lookup HDB block-level property profile.

Inputs:

- `block`
- `street`

Output:

- matching block rows
- dwelling unit breakdown
- completion year and rough age

### 7.7 `lookup_cea_salesperson`

Purpose:
Find active CEA salesperson registration records.

Inputs:

- `registration_no?`
- `salesperson_name?`
- `estate_agent_name?`
- `limit?`
- `select?`
- `include_raw?`: default false

Output:

- normalized compact matching rows
- normalized name fields
- match metadata:
  - `match_type`: `registration_exact | name_exact | name_contains | agency_contains`
  - `ambiguous`: boolean
  - `confidence`: `high | medium | low`

Important:
`registration_no` is the primary identity key. Name lookup should support exact and contains matching after a narrow server-side search if possible, but avoid scanning the whole dataset by default. Name-only matches are always potentially ambiguous; return all plausible matches up to `limit` and set `ambiguous=true` when more than one active registration matches.

### 7.8 `query_cea_transactions`

Purpose:
Convenience wrapper over CEA residential transaction rows.

Inputs:

- `salesperson_reg_num?`
- `salesperson_name?`
- `town?`
- `property_type?`: `HDB | PRIVATE`
- `transaction_type?`: `RESALE | RENTAL | NEW SALE | SUB SALE` depending on dataset values
- `represented?`: `BUYER | SELLER | LANDLORD | TENANT` depending on dataset values
- `district?`
- `general_location?`
- `min_transaction_month?`
- `max_transaction_month?`
- `limit?`
- `select?`
- `include_raw?`: default false

Output:

- normalized compact transaction rows
- optional grouped summary if `summarize=true`

### 7.9 `get_private_residential_rental_medians`

Purpose:
Fetch URA Data Service project-level private non-landed residential rental median rows.

Inputs:

- `project?`
- `district?`
- `from?`: `YYYY-Qn`
- `to?`: `YYYY-Qn`
- `limit?`: default 50, max 500
- `cursor?`
- `select?`
- `include_raw?`: default false

Output:

- normalized compact rows from source key `ura_private_rental_medians`
- p25/median/p75 PSF rent fields where provided by URA
- source period and sample size
- explicit disclaimer: public URA rental median records only; not rental valuation advice

Naming note:

- `ura_private_rental_medians` refers to URA Data Service `PMI_Resi_Rental_Median`.
- `ura_non_landed_rental_benchmark` is a separate data.gov.sg summary source, exposed through `query_housing_rows` unless a later convenience tool is added.

### 7.10 `find_private_residential_sale_comparables`

Purpose:
Find detailed URA private residential sale transaction rows from the past 5 years.

Inputs:

- `project?`
- `street?`
- `district?`
- `market_segment?`: `CCR | RCR | OCR`
- `property_type?`
- `type_of_sale?`: `new_sale | sub_sale | resale`
- `min_contract_month?`: `YYYY-MM`
- `max_contract_month?`: `YYYY-MM`
- `min_area_sqm?`
- `max_area_sqm?`
- `min_price?`
- `max_price?`
- `floor_range?`
- `limit?`
- `select?`
- `include_raw?`: default false
- `output_mode?`: `rows | summary | both`, default `both`
- `max_batches?`: default 4

Output:

- normalized compact transaction rows; raw URA backend fields only when `include_raw=true`
- summary stats for `price`, `price_psm`, and approximate `price_psf`
- source period and sample size
- `complete`, `truncated`, `rows_scanned`, `pages_scanned` or `batches_scanned`
- explicit disclaimer: public URA transaction records only; not valuation advice

Implementation notes:

- URA returns project objects with nested `transaction[]`. The tool should flatten them into one row per transaction while preserving project-level fields.
- The tool should hide URA batch mechanics from the user. If district filters map cleanly to a batch, query only the relevant batch; otherwise scan all 4 batches within caps.
- `contractDate` is `mmyy`; normalize to `YYYY-MM` using the documented 5-year coverage window.
- `price_psm = price / area` when both are numeric. `price_psf` is derived from square metres and should be labeled approximate.
- Coordinates are project-level coordinates, not unit-level coordinates.

### 7.11 `find_private_residential_rental_contracts`

Purpose:
Find detailed URA private residential rental contract rows from the past 5 years.

Inputs:

- `project?`
- `street?`
- `district?`
- `property_type?`
- `bedrooms?`
- `min_ref_period?`: `YYYY-Qn`
- `max_ref_period?`: `YYYY-Qn`
- `min_area_sqm?`
- `max_area_sqm?`
- `min_rent?`
- `max_rent?`
- `limit?`
- `select?`
- `include_raw?`: default false
- `output_mode?`: `rows | summary | both`, default `both`

Output:

- normalized compact rental contract rows; raw URA backend fields only when `include_raw=true`
- summary stats for rent and rent per area where possible
- source period and sample size
- `complete`, `truncated`, `rows_scanned`, `periods_scanned`
- explicit disclaimer: public URA rental contract data only; not rental valuation advice

### 7.12 `get_private_developer_sales`

Purpose:
Fetch URA developer sales records and price ranges for private residential projects from the past 3 years.

Inputs:

- `project?`
- `district?`
- `market_segment?`
- `ref_period?`
- `limit?`

Output:

- rows with `lowestPrice`, `medianPrice`, `highestPrice`, launched/sold counts, and project metadata
- source period and caveats

### 7.13 `get_private_market_index`

Purpose:
Fetch private residential price/rental index rows.

Inputs:

- `index_type`: `price | rental`
- `property_type?`
- `min_quarter?`
- `max_quarter?`
- `limit?`

Output:

- index rows

## 8. CLI Spec

CLI binary: `sg-housing`

Output defaults:

- JSON by default for agent/scripting friendliness.
- Optional `--table` for humans.
- Optional `--csv`.
- Machine-readable data always goes to stdout.
- Logs, progress, warnings, and diagnostics always go to stderr.
- `--json` is explicit even though JSON is the default.
- Errors in JSON mode use a stable shape:

```json
{
  "ok": false,
  "error": {
    "code": "SOURCE_UNAVAILABLE",
    "message": "Human-readable explanation",
    "details": {}
  }
}
```

Exit codes:

- `0`: success
- `1`: validation or user input error
- `2`: data.gov.sg/network/API error
- `3`: source unavailable or registry validation failure
- `4`: partial result refused because `allow_partial` was not set

Filter syntax:

- Repeated key/value filters:
  `--filter town="ANG MO KIO" --filter property_type=HDB`
- JSON filters for complex shell quoting:
  `--filters-json '{"town":"ANG MO KIO","property_type":"HDB"}'`
- If both are provided, `--filters-json` is applied first and repeated `--filter` values override matching keys.

Commands:

```bash
sg-housing sources --category hdb
sg-housing doctor --json
sg-housing doctor --mcp --json
sg-housing update-check --json
sg-housing validate-registry --json
sg-housing rows --source cea_residential_transactions --filter town="ANG MO KIO" --filter property_type=HDB --limit 50
sg-housing rows --source cea_residential_transactions --filters-json '{"town":"ANG MO KIO","property_type":"HDB","transaction_type":"RESALE"}' --limit 50 --select salesperson_reg_num,salesperson_name,transaction_date,town,property_type,transaction_type
sg-housing aggregate --source cea_residential_transactions --filter town="ANG MO KIO" --filter property_type=HDB --filter transaction_type=RESALE --operation top_n_by_count --group-by salesperson_reg_num,salesperson_name --top-n 10
sg-housing hdb resale --town "ANG MO KIO" --flat-type "4 ROOM" --from 2024-01 --limit 30
sg-housing hdb rent --town "QUEENSTOWN" --flat-type "4-ROOM" --from 2025-01
sg-housing hdb block --block 105 --street "ANG MO KIO AVE 4"
sg-housing cea salesperson --reg R012345A
sg-housing cea transactions --town YISHUN --property-type HDB --transaction-type RESALE --limit 50
sg-housing private sales --project "TURQUOISE" --type-of-sale resale --from 2022-01 --limit 30
sg-housing private sales --district 04 --property-type Condominium --min-area-sqm 100 --max-area-sqm 140 --limit 30 --select project,district,contract_month,area_sqm,price,price_psf
sg-housing private rentals --project "THE MINTON" --from 2024-Q1 --to 2026-Q1 --limit 30
sg-housing private rentals --project "120 GRANGE" --quarter 2026-Q1
sg-housing private developer-sales --project "THE ORIE"
sg-housing mcp
```

`sg-housing mcp` starts the stdio MCP server. This allows Claude CLI config to point at one binary.

CLI flag mapping:

- `--from` maps to `min_month`, `min_transaction_month`, `min_contract_month`, or `min_ref_period` depending on command.
- `--to` maps to the corresponding max field.
- `--quarter YYYY-Qn` is shorthand for `--from YYYY-Qn --to YYYY-Qn` on quarter-based rental/benchmark commands.
- `--top-n` maps to MCP `top_n`.
- `--operation` is required for generic `aggregate`; convenience commands may choose the operation internally.
- `--type-of-sale resale|sub_sale|new_sale` maps to URA `typeOfSale` values `3|2|1`.

First-run diagnostics:

- `sg-housing doctor --json` checks package version, Node/runtime compatibility, active `distribution_mode`, data.gov.sg reachability, URA detailed-tool availability, and source registry validation status.
- `sg-housing doctor --mcp --json` additionally checks MCP stdio hygiene and verifies that machine-readable output stays on stdout while diagnostics stay on stderr.
- `doctor` must never print URA access keys or tokens.
- `doctor` must not ask maintained-distribution end users to obtain URA credentials. In `public` or `development` mode it should explain the available options: maintained distribution, `URA_ACCESS_KEY`, or unavailable detailed URA tools.
- `doctor` may include a non-blocking npm update check cached for 24 hours; `sg-housing mcp` must not print upgrade prompts on startup.
- `sg-housing update-check --json` returns `current_version`, `latest_version`, `update_available`, and `next_action`. It never self-installs.
- Status values: `ok | degraded | unavailable`.
- Every non-`ok` check includes `next_action`.

## 9. Claude CLI Integration

Target usage:

Claude CLI should start the local MCP server through stdio.

Credential expectation:

- End users should not configure URA credentials when they install an approved maintained distribution.
- In a maintained distribution, `sg-housing mcp` should already have access through the approved credential strategy without exposing the maintainer's URA `AccessKey` to the user.
- Developers should use the maintained proxy by default. Direct `URA_ACCESS_KEY` is only a fallback for forked/internal builds without a proxy URL.
- `sg-housing sources --category ura --json` should show whether detailed URA private residential tools are available, without exposing credentials.

npm global install:

```bash
npm install -g sg-housing-data
sg-housing doctor --json
```

Public npm note:

- A public npm package cannot include a real maintainer URA access key.
- In public mode, detailed URA private residential tools are unavailable or hidden; HDB, CEA, and data.gov.sg-backed summary tools still work.
- For out-of-box detailed private sale/rental tools, use a maintained distribution with an approved credential strategy.

Claude CLI config when installed globally:

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

`npx` without global install:

```json
{
  "mcpServers": {
    "sg-housing": {
      "command": "npx",
      "args": ["-y", "sg-housing-data", "mcp"]
    }
  }
}
```

`npx` note:

- Public `npx -y sg-housing-data mcp` has public-mode behavior.
- Maintained `npx` is acceptable only if it resolves to a package/deployment configured with an approved maintained credential strategy.

Local source checkout:

```bash
npm install
npm run build
npm link
sg-housing doctor --json
```

Claude config for source checkout should still call the linked launcher:

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

Direct `node dist/mcp.js` is not the canonical entrypoint. If it is supported for development, detailed URA tools require `URA_ACCESS_KEY` in the environment unless the local deployment explicitly includes an approved maintained credential provider.

The server must write logs to stderr only. stdout is reserved for MCP protocol messages.

Smoke tests:

```bash
sg-housing sources --category cea --json
sg-housing doctor --json
sg-housing aggregate --source cea_residential_transactions --filter town="ANG MO KIO" --filter property_type=HDB --filter transaction_type=RESALE --operation top_n_by_count --group-by salesperson_reg_num,salesperson_name --top-n 5 --json
```

Maintained-distribution URA smoke test:

```bash
sg-housing private sales --project "TURQUOISE" --limit 5 --json
```

Expected Claude prompt after MCP is configured:

```text
Using sg-housing, find the top CEA salespersons by HDB resale transaction count in Ang Mo Kio. Verify whether the top registration numbers are currently active.
```

## 10. Query Composition Strategy

The MCP should help agents compose complex questions by exposing both rows and aggregations.

Example user question:
"Ang Mo Kio 哪个中介卖房最多？"

Expected agent flow:

1. Call `aggregate_housing_rows`:
   - source: `cea_residential_transactions`
   - filters: `town=ANG MO KIO`, `property_type=HDB`, `transaction_type=RESALE`
   - operation: `top_n_by_count`
   - group_by: `salesperson_reg_num`, `salesperson_name`
2. Optionally call `lookup_cea_salesperson` for top registration numbers to verify active status and agency.
3. Answer with counts, caveats, and source attribution.

If `aggregate_housing_rows` returns `complete=false`, the agent must not answer "the most" as a settled fact. It should either ask to narrow the query, request `allow_partial=true`, or phrase the result as a partial scan.

More complex example:
"Find agents active in Tampines rentals and compare whether they mainly represent tenants or landlords."

Expected flow:

1. Query/aggregate CEA transactions grouped by salesperson and represented.
2. Lookup top salesperson active records.
3. Agent produces explanation.

Important design point:
The MCP is not responsible for all business reasoning. It is responsible for safely retrieving and summarizing public rows so the agent can reason.

## 11. Normalization Rules

Input normalization:

- Towns: uppercase for exact matching where dataset stores uppercase.
- HDB flat types: support aliases:
  - `4 room`, `4-room`, `4 ROOM`, `4-RM`
  - normalize per source because datasets differ.
- Months:
  - HDB resale uses `YYYY-MM`.
  - CEA transactions use `MMM-YYYY`.
- URA uses `YYYY-Qn`.
- URA Data Service sale `contractDate` arrives as `mmyy`; normalize to `YYYY-MM`.
- URA Data Service rental `refPeriod` may arrive as `yyqq`; normalize to `YYYY-Qn`.
- Names:
  - preserve raw names;
  - optional case-insensitive contains match for small result sets;
  - avoid unbounded full scans.

Output normalization:

- Do not include raw backend fields by default.
- Include raw backend fields only when `include_raw=true` and the response remains within the row and size limits.
- Add normalized helper fields only where useful:
  - `month_iso`
  - `quarter`
  - numeric parsed fields like `resale_price_num`
  - `source_dataset_id`

Do not silently drop rows with `na` or `-`; include them unless numeric summary requires exclusion.

## 12. Limits and Failure Behavior

Defaults:

- row query `limit`: 50 rows
- comparable tool `limit`: 30 rows
- max MCP row limit: 500 rows
- aggregation scan default: 5000 rows
- aggregation scan max: 20000 rows

When a scan cap is reached:

- return partial results;
- set `truncated: true`;
- set `complete: false`;
- include `rows_scanned`;
- include `pages_scanned`;
- include `backend_total` if available;
- tell the agent to narrow filters or continue with cursor.
- refuse rank-style authoritative answers unless the caller set `allow_partial=true`.

Network/API errors:

- return structured error payloads in MCP and CLI results;
- include URL endpoint type, not full sensitive query if API keys are later added;
- do not retry aggressively because data.gov.sg has rate limits;
- use short request timeouts;
- respect `Retry-After` headers when present;
- use small bounded backoff for transient 429/5xx responses;
- expose rate-limit failures distinctly with error code `RATE_LIMITED`.

MCP error payload:

MCP tools should use MCP `isError` semantics where appropriate and still return JSON-readable content with this shape:

```json
{
  "ok": false,
  "distribution_mode": "public",
  "error": {
    "code": "URA_AUTH_FAILED",
    "message": "Detailed URA private residential tools are unavailable in this distribution.",
    "recoverable": false,
    "retry_after_seconds": null,
    "affected_sources": ["ura_private_residential_transactions"],
    "next_action": "Use the maintained distribution for detailed URA tools, or use data.gov.sg URA summary sources."
  }
}
```

Required error fields:

- `code`
- `message`
- `recoverable`
- `retry_after_seconds`
- `affected_sources`
- `next_action`

Agents should be able to decide whether to retry, narrow filters, use a fallback source, or explain a distribution limitation based on these fields.

URA shared-key failure behavior:

- If URA token generation fails after the refresh/retry flow, mark URA Data Service sources as `unavailable`.
- Return a targeted error code such as `URA_AUTH_FAILED`, `URA_RATE_LIMITED`, or `URA_SERVICE_UNAVAILABLE`.
- Continue serving HDB, CEA, and data.gov.sg-backed summary sources.
- Do not ask the end user to obtain their own URA key in normal product flows.
- Diagnostics for the maintainer may say "configured URA key failed", but must not reveal the key.
- In `public` mode, use `URA_REQUIRES_MAINTAINED_DISTRIBUTION` rather than `URA_AUTH_FAILED`, because this is an expected distribution limitation rather than an auth outage.

## 13. Security and Privacy

- Public data only.
- No end-user API key required for v1.
- The maintainer-supplied URA access key must not be exposed in normal product flows.
- Support `URA_ACCESS_KEY` for development and emergency override.
- If a maintained token broker/proxy is used, the local MCP sends only broker-approved requests and never receives the maintainer's URA `AccessKey`.
- Support `DATA_GOV_SG_API_KEY` later if data.gov.sg authenticated rate limits become useful.
- Do not store user queries.
- Do not write local cache files.
- Short-lived in-process metadata/schema cache is allowed and must not contain user query row results.
- URA daily tokens may be stored in process memory only and must be redacted from logs.
- MCP logs to stderr only.

## 14. Packaging

Package name proposal:

- npm package: `sg-housing-data`
- CLI binary: `sg-housing`
- MCP command: `sg-housing mcp`

Source layout proposal:

```text
src/
  cli.ts
  mcp.ts
  registry.ts
  datagov-client.ts
  ura-client.ts
  credentials.ts
  sources/
    hdb.ts
    cea.ts
    ura.ts
  query/
    filters.ts
    aggregate.ts
    normalize.ts
  output.ts
```

## 15. Implementation Milestones

Milestone 1: Spec and source registry

- finalize source keys and dataset IDs;
- add URA Data Service source definitions for detailed sale transactions, rental contracts, rental medians, and developer sales;
- define distribution modes and source availability behavior for `public`, `maintained`, and `development`;
- define the maintained credential provider:
  - public source contains only a placeholder;
  - maintained distribution uses a token broker/proxy, managed local provider, or explicitly authorized embedded key;
  - the maintained default proxy is preferred over local `URA_ACCESS_KEY` in the public package;
  - build/test checks prevent accidental real-key inclusion in public artifacts;
- document fields and caveats.
- implement `validate-registry` design:
  - verify collection membership;
  - verify required fields from sample rows/schema;
  - report source status `unknown | ok | warning | unavailable`.

Milestone 2: Data client

- `listRows(datasetId, cursor, limit)`
- `searchRows(datasetId, filters, offset, limit)`
- `getUraToken(accessKey)`
- `invokeUraDataService(service, params)`
- URA token in-memory lifecycle:
  - lazy token creation;
  - Singapore-date daily refresh;
  - refresh and retry once on token/auth failure;
  - single-flight refresh across concurrent calls;
  - credential redaction
- opaque cursor encode/decode
- metadata fetcher
- short-lived in-process metadata/schema cache
- timeout, retry-after, and bounded backoff behavior
- error handling

Milestone 3: CLI

- `sources`
- `rows`
- `aggregate`
- `doctor`
- `validate-registry`
- HDB/CEA convenience commands
- canonical `sg-housing mcp` launcher path for all install modes
- CLI-to-MCP flag mapping tests for copy-paste examples

Milestone 4: MCP

- `list_housing_sources`
- `query_housing_rows`
- `aggregate_housing_rows`
- HDB/CEA/data.gov.sg URA convenience tools
- URA Data Service tools:
  - `find_private_residential_sale_comparables`
  - `find_private_residential_rental_contracts`
  - `get_private_developer_sales`

Milestone 5: Claude CLI smoke tests

- configure local MCP;
- run `sg-housing doctor --mcp --json`;
- verify public-mode behavior degrades gracefully for detailed URA tools;
- verify maintained-mode behavior supports detailed URA tools without end-user configuration;
- verify stdout/stderr behavior for CLI and MCP;
- verify MCP row-returning tools enforce max row count, compact default fields, `include_raw=false`, and response-budget truncation;
- verify truncated aggregation refuses authoritative `top_n_by_count` unless `allow_partial=true`;
- ask:
  - "Ang Mo Kio 哪个中介 HDB resale 最多？"
  - "查 Rxxxxxx 的 CEA 状态和交易记录。"
  - "Queenstown 4-room HDB 最近租金如何？"
  - "Find recent private condo resale comparables for TURQUOISE."

## 16. Open Questions

- Should v1 include raw `datastore_search_sql`? Recommendation: no. It is powerful but increases injection/complexity risk.
- Should CEA name search allow full dataset scan? Recommendation: no by default; require registration number, exact/contains query, or explicit `--scan` in CLI only.
- Should MCP expose continuation cursors across calls? Recommendation: yes, because no cache means cursor-based continuation is the safest way to let agents fetch more.
- Should we normalize all historical HDB resale datasets into one source? Recommendation: yes for `hdb_resale_transactions`, but expose `period`/`source_dataset_id` so date-basis caveats remain visible.
- What happens if maintained URA usage grows beyond expectation and hits limits? Recommendation: add telemetry-free local error counters and a maintainer-visible troubleshooting command; support user-provided override while keeping approved maintained distributions as smooth as possible.
- Should detailed URA private sale transactions replace data.gov.sg URA quarterly summaries? Recommendation: no. Keep both. Detailed transactions answer comparable questions; quarterly summaries answer market trend questions with lower API cost.
