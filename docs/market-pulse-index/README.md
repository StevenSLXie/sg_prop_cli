# Singapore Condo Market Pulse Prototype

This folder contains the standalone prototype for the Singapore Condo Market Pulse index. It is intentionally separate from the main CLI/MCP runtime.

## Run

```bash
node docs/market-pulse-index/build-market-pulse.mjs
```

Pull only the normalized URA transaction snapshot:

```bash
node docs/market-pulse-index/pull-ura-snapshot.mjs
```

Build the soft matched-basket v0.4 prototype from the snapshot:

```bash
node docs/market-pulse-index/build-soft-matched-pulse.mjs --core-only
```

Build all soft matched-basket series and render the main charts:

```bash
node docs/market-pulse-index/build-soft-matched-pulse.mjs
node docs/market-pulse-index/render-soft-matched-charts.mjs
```

Compare quarter-end results against URA/SingStat official non-landed indexes:

```bash
node docs/market-pulse-index/compare-with-ura.mjs
node docs/market-pulse-index/compare-soft-matched-with-ura.mjs
```

Compare the prototype against URA and SRX public monthly market movements:

```bash
node docs/market-pulse-index/compare-three-indexes.mjs
```

Optional flags:

```bash
node docs/market-pulse-index/build-market-pulse.mjs \
  --broker-url https://sg-housing-data-mcp-spec.vercel.app/api/ura \
  --out docs/market-pulse-index/output \
  --save-snapshot
```

## Outputs

The script writes:

- `output/index-points.csv`
- `output/index-points.json`
- `output/sample-audit.json`
- `output/normalized-snapshot.json`
- `output/soft-matched-index-points.csv`
- `output/soft-matched-index-points.json`
- `output/soft-matched-sample-audit.json`
- `output/soft-matched-ura-comparison.csv`
- `output/soft-matched-ura-comparison.json`
- `output/soft-matched-ura-comparison.svg`
- `output/soft-matched-resale-by-size.svg`
- `output/soft-matched-resale-by-region.svg`
- `output/soft-matched-resale-key-districts.svg`
- `output/soft-matched-new-sale-by-size.svg`
- `output/soft-matched-new-sale-by-region.svg`
- `output/soft-matched-new-sale-key-districts.svg`
- `output/ura-comparison.csv`
- `output/ura-comparison.json`
- `output/ura-comparison.svg`
- `output/three-index-comparison.csv`
- `output/three-index-comparison.json`
- `output/three-index-comparison.svg`
- `output/normalized-snapshot.json` when `--save-snapshot` is set

Historical runs from the current URA proxy are labelled `revised_backtest`, because the proxy does not expose historical as-of snapshots. Live production publication requires storing monthly snapshots going forward.

The SRX comparison uses `srx-monthly-public.csv`, which records monthly percentage changes from SRX research articles and chains them into a relative index. It is a public-source proxy rather than a raw SRX index-value pull, because SRX's index-value table is not exposed through the same stable public API pattern as URA/data.gov.sg.

## Soft Matched-Basket v0.4

The v0.4 prototype reduces within-cell quality drift without fitting a hedonic regression. It uses trailing historical basket weights and chooses the best available matched return for each historical atom:

- `project x size` with floor-distance kernel, weight multiplier `2.00`
- fallback universe cell with floor-distance kernel, weight multiplier `1.00`

If the same project cannot be matched within the same size band, the atom uses the fallback cell instead of project-only movement. Floor range is not an exact-match requirement; it is converted to a midpoint and used as a soft distance score when matching current-window transactions to previous-window transactions. Weights come from transactions before the current window, so the method does not use future or current-window composition as the basket. A single project is capped at 15% effective weight. Each output point includes matched coverage, fallback share, top project weight, floor similarity, sample size, and confidence.

The same method is computed separately for `resale` and `new_sale`, so users can distinguish secondary-market movement from new-launch mix and pricing.

## Scope

Included:

- URA `PMI_Resi_Transaction`
- resale
- new sale
- `Condominium` and `Apartment`

Excluded:

- sub sale
- Executive Condominium
- landed
- rows with invalid price, area, or contract month

Size segments:

- `compact`: `<=800 sqft`
- `family`: `>800 and <=1200 sqft`
- `large`: `>1200 sqft`
