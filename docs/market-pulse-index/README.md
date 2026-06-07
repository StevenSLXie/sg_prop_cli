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

Build the soft matched-basket v0.5 prototype from the snapshot:

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

## Soft Matched-Basket v0.5

The v0.5 prototype reduces within-cell quality drift without fitting a hedonic regression. For resale, it uses trailing historical basket weights and chooses the best available matched return for each historical atom:

- `project x size` with floor-distance kernel, weight multiplier `1.00`
- fallback universe cell median, weight multiplier `1.00`

If the same project cannot be matched within the same size band, the atom uses the fallback cell instead of project-only movement. Project matching uses `district x project x street` to avoid linking generic project names across unrelated streets. Fallback cells prefer `universe cell x size x tenure bucket`, where `freehold` and `999-year` rows are separated from shorter leasehold rows, then fall back to the same cell without tenure only when the tenure-specific cell is too sparse. Floor range is used only inside same-project matches; broad fallback cells use medians because applying a floor kernel across unrelated projects can turn project, age, stack, or view differences into false floor adjustments. Weights come from transactions before the current window, so the method does not use future or current-window composition as the basket. Matched and fallback returns are first reduced to normalized cell returns, then the final index return is aggregated using lagged cell weights. This final cell normalization prevents the presence of matched projects from changing the district or regional composition. A single project is capped at 15% effective weight after redistribution. Resale points with almost no matched support are shown with lower confidence. Resale excludes multi-unit or bulk transactions where `no_of_units` is not `1`. Each output point includes matched coverage, fallback share, top project weight, floor similarity, sample size, confidence, public segment id, and a diagnostic raw chain. Public charts and `price_index` use only confidence-gated points; the raw chain is not used as a published index.

The same method is computed separately for `resale` and `new_sale`, so users can distinguish secondary-market movement from new-launch mix and pricing.

For `new_sale`, project-level repeat matching is disabled by default. New launches often sell through in concentrated windows, so repeated project observations are treated as launch-phase mix rather than repeat-market evidence. New sale indexes therefore use fallback `district x size` cell medians weighted by the previous 3-month window, not the 24-month resale basket. Floor is not kernel-adjusted for new sale because launch-floor pricing is part of new-launch price formation.

The overall index also uses `district x size` fallback cells, not only `market segment x size`, to avoid treating cross-district launch mix as market-wide price movement.

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
