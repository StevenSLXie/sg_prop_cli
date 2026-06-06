# Turnover Methodology

Turnover is a liquidity proxy, not a valuation.

## Preferred Layout Turnover

```text
layout_turnover_rate = layout_transactions_last_12_months / verified_layout_unit_count
```

Use this only when the layout unit count is sourced or clearly defensible.

## Fallback Project Turnover

```text
project_turnover_rate = project_transactions_last_12_months / total_project_units
```

Use this when bedroom/layout supply is not available.

## Interpretation

| Annual Turnover | Interpretation |
|---:|---|
| <1% | Very thin liquidity; evidence is weak |
| 1-3% | Low to moderate liquidity |
| 3-6% | Healthy resale liquidity |
| >6% | Active market; check why activity is high |

## Caveats

- Large projects usually have more visible transactions.
- Low turnover can mean owners like holding, or simply poor liquidity.
- High turnover can be healthy, or a sign of investor churn.
- A small denominator can make percentages misleading.
- URA rows do not include bedroom count, so layout turnover often needs external unit-mix data.
- Do not report layout turnover as exact unless both the last-12-month layout transaction count and layout unit-count denominator are defensible.
