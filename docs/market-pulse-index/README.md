# Singapore Condo Market Pulse Prototype

This folder contains the standalone prototype for the Singapore Condo Market Pulse index. It is intentionally separate from the main CLI/MCP runtime.

## Run

```bash
node docs/market-pulse-index/build-market-pulse.mjs
```

Compare quarter-end results against URA/SingStat official non-landed indexes:

```bash
node docs/market-pulse-index/compare-with-ura.mjs
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
- `output/ura-comparison.csv`
- `output/ura-comparison.json`
- `output/ura-comparison.svg`
- `output/normalized-snapshot.json` when `--save-snapshot` is set

Historical runs from the current URA proxy are labelled `revised_backtest`, because the proxy does not expose historical as-of snapshots. Live production publication requires storing monthly snapshots going forward.

## Scope

Included:

- URA `PMI_Resi_Transaction`
- resale only
- `Condominium` and `Apartment`

Excluded:

- new sale
- sub sale
- Executive Condominium
- landed
- rows with invalid price, area, or contract month

Size segments:

- `compact`: `<=800 sqft`
- `family`: `>800 and <=1200 sqft`
- `large`: `>1200 sqft`
