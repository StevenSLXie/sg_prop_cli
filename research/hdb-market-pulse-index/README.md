# HDB Market Pulse Prototype

This research module builds a first-pass HDB resale market pulse from the data.gov.sg HDB resale transaction feed.

It intentionally shares only generic utilities with the condo market pulse prototype through `research/lib/market-pulse-core.mjs`. HDB keeps its own data pull, normalization, universe design, match tiers, and confidence rules because HDB has different structure: `flat_type` is a strong room-count proxy, remaining lease is first-class, and there is no private-condo project name.

## Run

```bash
node research/hdb-market-pulse-index/build-hdb-pulse.mjs
node research/hdb-market-pulse-index/render-hdb-charts.mjs
```

Both commands support `--out`. The renderer reads the chart date range from `hdb-index-points.json` by default, with optional `--start-month` and `--end-month` overrides.

For repeat runs without hitting data.gov.sg again:

```bash
node research/hdb-market-pulse-index/build-hdb-pulse.mjs --use-existing-snapshot
```

By default the build computes overall, flat-type, remaining-lease, and town indexes. Full `town x flat_type` series are useful for deep dives but slower, so they are opt-in:

```bash
node research/hdb-market-pulse-index/build-hdb-pulse.mjs --use-existing-snapshot --include-town-flat
```

## Method Summary

Published cell:

```text
town x flat_type
```

Normalization attributes:

```text
area_bucket_10sqm
remaining_lease_10y
```

Match enhancement tiers:

```text
same block + street + flat_type + area bucket + lease bucket
same street + flat_type + area bucket + lease bucket
same town + flat_type + area bucket + lease bucket
fallback town + flat_type
```

Floor is not a hard cell dimension. It is applied as a kernel inside matched tiers:

```text
similarity = exp(-floor_distance / 8)
```

Single block and street concentration are capped after match boosting:

```text
block cap = 15%
street cap = 30%
```

The first version starts at `2022-01`. Public `price_index` points are quarterly and compare non-overlapping current-quarter and previous-quarter windows. Monthly 3-month rolling windows are still computed for short-term momentum and liquidity diagnostics, but they are not chained into the long-run price index because overlapping windows can self-match and understate cumulative moves.

## Outputs

- `output/normalized-hdb-snapshot.json`
- `output/hdb-index-points.json`
- `output/hdb-index-points.csv`
- `output/hdb-cell-audit.csv`
- `output/hdb-flat-model-area-audit.csv`
- `output/hdb-sample-audit.json`
- `output/hdb-resale-by-flat-type.png`
- `output/hdb-resale-by-remaining-lease.png`
- `output/hdb-resale-key-towns.png`
