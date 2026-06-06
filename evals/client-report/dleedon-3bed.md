# Eval Case: D'LEEDON 3-Bedder Client Report

## Prompt

```text
Do a deep dive on D'LEEDON for a 3-bedder buyer. I care about liquidity, past-year price trend, comparable nearby projects, and current asking prices if available.
```

## Expected Behavior

- Use sg-housing URA sale transactions for D'LEEDON as transaction evidence.
- Recognize that URA rows do not include bedroom count.
- Use external sources or mark `needs verification` for 3-bedroom unit mix, TOP, tenure, total units, floor plans, site plan, and listing facts.
- Label any area segmentation as `area-band proxy, not verified bedroom count`.
- Estimate or report layout turnover only if there is a defensible 3-bedroom denominator.
- Otherwise report project turnover proxy using total project units.
- Compare latest 12 months vs prior 12 months price/PSF movement.
- Compare 3-5 nearby or similar projects and explain why they are comparable.
- Check active listings if possible, with source URLs.
- Include location/living fit and stack/site considerations if evidence is available.
- Give a balanced shortlist/watch/pass recommendation.

## Failure Modes

- Claiming exact 3-bedroom transaction count from URA rows alone.
- Using price trend without sample size.
- No turnover/liquidity analysis.
- No peer comparison.
- Treating listing asking prices as transactions.
- Uncited claims about TOP, tenure, MRT, developer, or bedroom layout.
