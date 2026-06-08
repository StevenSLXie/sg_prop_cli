# Singapore Condo Market Pulse Technical Design

## Status

Draft for review.

This document designs a price and liquidity index family for Singapore resale private non-landed condominium/apartment transactions. It is intentionally scoped away from bedroom-count indexes because the currently available URA sale transaction rows do not contain bedroom count.

## Goals

- Build an attractive, explainable market pulse product for buyers, agents, and property researchers.
- Publish monthly signals using 3-month rolling transaction windows.
- Support separate views for:
  - whole-market resale condo/apartment market,
  - CCR / RCR / OCR,
  - districts,
  - coarse size segments.
- Avoid data leakage: every point must be computable using only information available as of that publication month.
- Avoid small-sample overfitting and high-dimensional regression where the signal is likely noise.
- Expose sample size, coverage, and confidence for every reported point.

## Non-Goals

- Do not replicate URA PPI, SRX SPI, or NUS SRPI exactly.
- Do not publish a 1/2/3-bedroom index unless a stable, licensed, transaction-level bedroom source is available.
- Do not include new sales, sub-sales, ECs, landed housing, or HDB in this first index family.
- Do not produce valuation advice for any individual unit.

## Related Provider Methodology

### URA PPI

URA publishes the official Private Residential Property Price Index. URA states that it uses a stratified hedonic regression method and controls for property attributes such as unit size and age, with fixed weights based on prior transaction values. URA PPI is official and robust, but quarterly and macro-level.

References:

- URA REALIS coverage and methodology: https://eservice.ura.gov.sg/reis/coverageandMethodology
- URA private residential price index on data.gov.sg: https://data.gov.sg/collections/1676/view

### SRX SPI

SRX publishes monthly sale/rental indexes and describes a hedonic regression approach where log price psf is adjusted by property characteristics such as tenure, age, size, floor, location, and time dummies. SRX has proprietary and agency data that is not available to this package.

Reference:

- SRX price index page: https://www.srx.com.sg/price-index

### NUS SRPI

NUS SRPI is a monthly transaction-based index for non-landed private residential properties, with Overall, Central, Non-Central, and Small Units indexes. Its public materials describe value-weighted fixed basket concepts and flash/revised estimates.

Reference:

- NUS SRPI page: https://ireus.nus.edu.sg/publications/real-estate-market-indexes/singapore-residential-price-index-srpi/srpi/

## Methodological Choice

Use an as-of weighted, 3-month rolling, stratified median PSF index.

This is deliberately not a high-dimensional hedonic model. The expected product value comes from:

- clean resale condo/apartment scope,
- rolling timeliness,
- district and region segmentation,
- size-segment interpretation,
- confidence and liquidity signals,
- transparent methodology.

The method controls for changing transaction mix by using coarse size cells and fixed historical weights. It avoids estimating many noisy coefficients when district-level samples are small.

## Data Sources

### Primary Transaction Source

URA Data Service `PMI_Resi_Transaction`, accessed through the package's maintained URA proxy.

Required fields currently available in `sg-housing`:

| Field | Available | Use |
|---|---:|---|
| `project` | yes | project-level diagnostics, duplicate checks |
| `street` | yes | metadata and debugging |
| `market_segment` | yes | CCR / RCR / OCR view |
| `district` | yes | district view |
| `contract_month` | yes | rolling windows |
| `type_of_sale` | yes | filter to resale |
| `property_type` | yes | filter to condo/apartment |
| `area_sqm` | yes | size segment |
| `price` | yes | transaction value, outlier checks |
| `price_psf` | derived | price index input, computed from `price / area_sqm / 10.7639104167` |
| `floor_range` | yes | diagnostics only in v1 |
| `tenure` | yes | diagnostics only in v1 |
| `no_of_units` | internal only | derived by the current flattener, but not exposed in the public source registry or MCP schema |

Implementation note: bulk filtering via `no_of_units > 1` is not currently available through the public MCP/CLI surface. The production indexer must either use the internal URA flattener directly, expose `no_of_units` as a supported field, or omit bulk filtering and mark that limitation.

### Excluded Data

- URA rental rows have `bedrooms`, but rental bedroom labels cannot directly label sale transactions.
- External portals such as EdgeProp may show transaction bedroom count, but this implies enrichment unavailable in current public URA sale rows. Do not use scraped or unlicensed bedroom data in the official index.
- Active listings are useful for client reports and asking-pressure research, but not part of the core price index unless a stable listing feed is licensed.

## Index Universe

Base universe:

```text
type_of_sale = resale
property_type in ["Condominium", "Apartment"]
exclude Executive Condominium
exclude landed
exclude new sale
exclude sub sale
```

Reasoning:

- New sales have launch pricing, staged releases, discounts, and developer behavior.
- ECs have distinct eligibility, upgrade, and lifecycle dynamics.
- Landed properties are structurally different and sparse.
- Resale condo/apartment transactions are the cleanest match for buyer/agent market pulse.

## Dimensions

### Whole Market

```text
SG_CONDO_RESALE_OVERALL
```

### Market Segment

```text
SG_CONDO_RESALE_CCR
SG_CONDO_RESALE_RCR
SG_CONDO_RESALE_OCR
```

### District

```text
SG_CONDO_RESALE_D01 ... SG_CONDO_RESALE_D28
```

District availability depends on confidence rules. Low-sample districts may be published only as low-confidence pulse or suppressed.

### Size Segment

Size segment is a buyer-oriented proxy, not bedroom count.

| Segment | Sqft | Sqm | Label |
|---|---:|---:|---|
| Compact | `<= 800` | `<= 74` | roughly 1-2BR buyer market |
| Family | `>800 and <=1200` | `>74 and <=111` | roughly 3BR buyer market |
| Large | `>1200` | `>111` | roughly 4BR+ / larger family market |

The product must not call these bedroom indexes.

## Sample Audit

A one-off audit was run on 2026-06-07 using URA `PMI_Resi_Transaction` via the maintained proxy.

Audit scope:

- Period: 2021-06 to 2026-05.
- Raw rows: 137,914.
- Target-scope resale condo/apartment rows, excluding EC: 61,536.

Recent target-scope quarterly counts from the audit:

| Quarter | Count |
|---|---:|
| 2023Q2 partial | 854 |
| 2023Q3 | 2,570 |
| 2023Q4 | 2,490 |
| 2024Q1 | 2,498 |
| 2024Q2 | 3,311 |
| 2024Q3 | 3,356 |
| 2024Q4 | 3,201 |
| 2025Q1 | 3,166 |
| 2025Q2 | 3,186 |
| 2025Q3 | 3,376 |
| 2025Q4 | 2,942 |
| 2026Q1 | 2,721 |
| 2026Q2 partial | 1,812 |

Do not use partial natural quarters as quarterly validation points. They are included above only to show data boundaries. For quarterly validation, use full natural quarters only.

Market segment quarterly median counts:

| Segment | Quarterly Median Count |
|---|---:|
| OCR | 1,475 |
| RCR | 884 |
| CCR | 559 |

District-level conclusion from the same audit, based primarily on 3-month rolling counts:

- Strong sample districts: D19, D15, D18, D10, D14, D05, D23, D09, D16, D03, D20, D21, D12, D11, D27.
- Medium sample districts: D13, D04, D17, D28, D22, D08, D01.
- Borderline districts: D02, D07, D25.
- Insufficient districts: D26, D06.

Production should persist the exact audit query and rerun it before final thresholds are locked.

The next audit must also report active-cell coverage, not just district totals. A district can have enough total transactions but still fail after splitting into Compact / Family / Large cells, especially when comparing `W_t` and `W_{t-1}`.

## Publication Timeline

Publish a new 3-month rolling point each month.

For month `t`:

```text
W_t = {t-2, t-1, t}
```

Examples:

| Publication Label | Rolling Window |
|---|---|
| 2026-03 | 2026-01 to 2026-03 |
| 2026-04 | 2026-02 to 2026-04 |
| 2026-05 | 2026-03 to 2026-05 |

The change from 2026-04 to 2026-05 is a 3-month rolling momentum, not a strict monthly return, because the windows overlap by two months.

Any pulse-score threshold based on rolling momentum must be empirically calibrated. A 2% move in overlapping 3-month windows is not equivalent to a 2% clean monthly return.

## Data Availability Cutoff

To avoid data leakage and unstable late-arriving records, each published point needs an as-of date.

Important limitation: the current maintained URA proxy returns the current upstream view. It does not expose ingestion date, last-seen date, revision timestamp, or historical as-of snapshots. Therefore, any historical run computed today from old contract months is a `revised_backtest`, not a perfect reconstruction of what was known on each past publication date.

Going forward, production must persist monthly snapshots to make as-of publication reproducible:

```text
snapshot_id
pulled_at
source_service
raw_response_hash
normalized_row_hash
contract_month
row_count
```

Suggested production convention for live publication:

```text
as_of_date = publication_date
included_contract_months = rolling window months whose records are available from URA by as_of_date
```

If URA records for the latest contract month are incomplete, mark the point:

```text
provisional = true
revision_risk = high | medium | low
```

The final publication calendar should empirically measure URA update lag by comparing repeated pulls for the same contract month.

## Core Price Formula

### Stratification Cells

The cell definition depends on the universe. This is necessary because size-only cells do not control enough mix shift for broad indexes.

| Universe | Cell Definition |
|---|---|
| Overall | `market_segment x size_segment` |
| CCR / RCR / OCR | `district x size_segment` where sample permits; otherwise `size_segment` |
| District | `size_segment` |
| Size segment | `market_segment` where sample permits; otherwise direct size-segment median |
| District + size segment | direct universe median, only when confidence is sufficient |

For cells that include `district`, the active-cell and coverage rules are mandatory. If active coverage is too low, fall back to the coarser cell definition or suppress the point.

### Rolling Window Median

For each universe `u`, size cell `c`, and rolling window `W_t`:

```text
P_{c,t} = median(price_psf_i), for transactions i in c during W_t
```

Before computing medians:

- remove rows with missing or non-positive `area_sqm`, `price`, or `price_psf`,
- remove bulk transactions if `no_of_units > 1` only when the production indexer has access to that internal field,
- optionally winsorize `price_psf` by as-of historical p1-p99 thresholds for the same universe/size cell.

### Active Cell Rule

A cell can contribute to the index at time `t` only if:

```text
n_{c,t} >= cell_min_n
n_{c,t-1} >= cell_min_n
```

Suggested starting value:

```text
cell_min_n = 8
```

### As-Of Weights

Weights must not use future information.

For point `t`, define the weight lookback period:

```text
B_t = 24 months ending immediately before W_t
```

Since:

```text
W_t = {t-2, t-1, t}
```

then:

```text
B_t = {t-26 ... t-3}
```

For each universe `u` and cell `c`:

```text
w_{c,t} =
  transaction_value_{c,B_t}
  / sum(transaction_value_{k,B_t}) for all cells k in universe u
```

`transaction_value` is the sum of transaction prices, not count. This value-weighting aligns better with market-value exposure. A count-weighted variant can be produced as a diagnostic but should not be the headline.

If `B_t` has insufficient history, do not backfill with future data. Either:

- start the index later,
- use a shorter as-of lookback with a `short_history=true` flag,
- or suppress the point.

### Cell Return

For active cells:

```text
r_{c,t} = log(P_{c,t} / P_{c,t-1})
```

### Universe Return

For universe `u`:

```text
R_{u,t} =
  sum_{c in A_{u,t}} w_{c,t} * r_{c,t}
  / sum_{c in A_{u,t}} w_{c,t}
```

where `A_{u,t}` is the set of active cells in universe `u` at time `t`.

### Price Index

Set the first valid index point to 100:

```text
I_{u,t0} = 100
I_{u,t} = I_{u,t-1} * exp(R_{u,t})
```

### Direct Size Segment Index

For a size-segment universe such as `SG_CONDO_RESALE_SIZE_FAMILY`, do not split further by size. Use:

```text
P_{u,t} = median(price_psf_i), for transactions i in u during W_t
R_{u,t} = log(P_{u,t} / P_{u,t-1})
I_{u,t} = I_{u,t-1} * exp(R_{u,t})
```

For `district + size_segment` views, publish only when confidence is sufficient.

Direct size-segment indexes remain exposed to region and project mix shifts within the same size band. Prefer `market_segment` cells for size-segment indexes when coverage permits, and report a mix-shift caveat when using direct size-segment medians.

## Liquidity Formula

For universe `u`:

```text
V_{u,t} = transaction_count in W_t
```

Define baseline using an as-of trailing period:

```text
Vbase_{u,t} = median(V_{u,k}) for rolling windows k whose end month is in B_t
```

Liquidity index:

```text
L_{u,t} = 100 * V_{u,t} / Vbase_{u,t}
```

Interpretation:

- `L = 120`: current 3-month transaction count is 20% above as-of normal.
- `L = 80`: current 3-month transaction count is 20% below as-of normal.

## Stability / Dispersion

Use cell-return dispersion as a noise indicator:

```text
sigma_{u,t} = weighted_median_abs_deviation(r_{c,t})
```

If implementation cost is high, use unweighted median absolute deviation first:

```text
sigma_{u,t} = median(|r_{c,t} - median(r_{c,t})|)
```

High dispersion means the universe-level return may be hiding mixed internal signals.

## Coverage And Confidence

Coverage:

```text
coverage_{u,t} =
  sum(w_{c,t}) for active cells
  / sum(w_{c,t}) for all cells in universe u
```

Confidence:

```text
High:
  n_{u,t} >= 80
  coverage_{u,t} >= 0.70

Medium:
  n_{u,t} >= 40
  coverage_{u,t} >= 0.50

Low:
  n_{u,t} >= 25

No Index:
  n_{u,t} < 25
```

The product may still show low-confidence pulse diagnostics, but should not present them as headline price moves.

## Pulse Score

The price index should remain the primary statistic. A composite pulse score can help users scan the market, but it must be secondary.

Definitions:

```text
price_momentum_score = clamp(R_{u,t} / 0.02, -1, 1)
liquidity_score = clamp(log(L_{u,t}/100) / log(1.5), -1, 1)
stability_multiplier = clamp(1 - sigma_{u,t}/0.03, 0.5, 1)
confidence_weight = High: 1, Medium: 0.75, Low: 0.4, No Index: 0
```

Composite:

```text
PulseScore_{u,t} =
  100
  * confidence_weight
  * stability_multiplier
  * (
      0.55 * price_momentum_score
    + 0.30 * liquidity_score
    )
```

Stability is a reliability penalty, not a positive heating signal. It should reduce directional scores when cell-level returns disagree; it should not push a flat market upward.

Labels:

| Score | Label |
|---:|---|
| `> +50` | Heating |
| `+15 to +50` | Warming |
| `-15 to +15` | Stable |
| `-50 to -15` | Cooling |
| `< -50` | Weak |

## No-Lookahead Rules

Every calculation must be reproducible as-of publication time.

Hard rules:

- Do not calculate weights from the full historical dataset if publishing historical points.
- Do not use transactions after `W_t` to compute `I_{u,t}`.
- Do not use current window `W_t` to compute `w_{c,t}`.
- Do not use future revisions to construct a historical backtest unless the output is explicitly labelled `revised_backtest`.
- Do not use future project composition, future transaction values, or future outlier thresholds for earlier points.
- Outlier thresholds must be computed from as-of historical data, not the full series.

Recommended stored metadata for each point:

```text
index_key
period_end_month
window_start_month
window_end_month
as_of_date
provisional
sample_size
active_cell_count
coverage
confidence
price_index
rolling_momentum
liquidity_index
pulse_score
revision_risk
method_version
```

## Revision Policy

Because URA records may arrive or revise after initial publication:

- `flash`: published soon after month end, latest month may be incomplete.
- `revised`: republished after enough lag is observed.
- `final`: locked after a fixed delay, for example 60-90 days after month end.

The exact delay should be determined by measuring URA transaction count changes over repeated pulls.

## Validation Plan

### Data Availability Validation

Run monthly:

- counts by month,
- counts by universe,
- counts by district,
- counts by size segment,
- missing field rates,
- `no_of_units > 1` share,
- distribution of `price_psf`, `area_sqm`, and `price`.

### Methodology Validation

Backtest without lookahead:

1. For each historical point, compute weights and outlier thresholds only using the as-of lookback.
2. Compare rolling pulse direction with:
   - URA PPI at quarterly level,
   - NUS SRPI central/non-central direction,
   - SRX monthly direction where available.
3. Measure revision stability:
   - initial vs revised vs final.
4. Measure sensitivity:
   - value weights vs count weights,
   - cell min sample threshold 5 vs 8 vs 10,
   - size bands with and without `1200 sqft` cutoff.
5. Flag districts where methodology is unstable.

### Product Validation

For each published month, generate a report:

- market-wide heat/cool summary,
- CCR/RCR/OCR divergence,
- top heating and cooling districts,
- liquidity leaders/laggards,
- low-confidence districts,
- explanation of what changed from prior rolling window.

## Open Questions

- Should EC resale be a separate index later? It is excluded from headline scope.
- Should `Apartment` and `Condominium` be pooled permanently? Current design says yes, but validation should compare them.
- Should transaction value weights or count weights be the headline? Current design says value weights.
- What is the observed URA update lag for the latest contract month?
- Should the production indexer expose or internally use `no_of_units` so bulk transactions can be excluded by default?
- What confidence threshold is needed before showing `district + size_segment` views?

## Recommended Next Step

Implement a research script under this folder or `scripts/` that:

1. pulls URA resale condo/apartment transactions,
2. excludes EC and bulk transactions,
3. computes the sample audit,
4. computes the first no-lookahead rolling index backtest,
5. exports CSV/JSON for review.

No public index should be shipped until the no-lookahead backtest and data availability audit pass.

## Prototype Implementation

The first standalone prototype lives in this folder:

```bash
node research/market-pulse-index/build-market-pulse.mjs
```

It writes JSON/CSV outputs under:

```text
research/market-pulse-index/output/
```

The prototype:

- pulls URA `PMI_Resi_Transaction` through the maintained proxy,
- filters to resale `Condominium` and `Apartment`,
- excludes EC, new sale, sub sale, and landed rows,
- computes overall, CCR/RCR/OCR, district, and size-segment indexes,
- labels outputs as `revised_backtest`,
- applies 3-month rolling windows, as-of trailing weights, coverage, confidence, liquidity, and pulse score.

The output directory is intentionally gitignored.
