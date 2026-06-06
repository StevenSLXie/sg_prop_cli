# Buyer Shortlist Eval Checklist

Use this checklist to score any generated report.

Each item is pass/fail.

## Query Planning

- Extracted budget, location, size, tenure/layout preferences where present.
- Converted sqft to sqm when needed.
- Used transaction summary before fetching detailed rows.
- Kept tool calls bounded.
- Used external sources or explicit caveats for metadata not in URA rows.

## Evidence

- Stated time window.
- Stated sample size.
- Included price and PSF context.
- Included project-level comparison.
- Did not claim unit-level facts unavailable from the data.

## Report Quality

- Gave a concise feasibility answer.
- Produced a shortlist table.
- Highlighted 3-5 next-step projects.
- Included watch-outs.
- Stated not valuation advice.

## Automatic Minimum Gate

For a report to pass the minimum gate, it must include:

- Area conversion if sqft appears in the prompt.
- Sample size.
- Transaction window.
- Project shortlist.
- Bedroom/layout caveat if bedroom count appears in the prompt.
- Source name + URL for external project metadata claims, or `needs verification`.
- No raw JSON dump.

The automated evaluator can score a generated report:

```bash
npm run eval:skills -- --report path/to/report.md --case d18
```

It checks for area conversion, sample size, transaction window, shortlist/table shape, bedroom caveats, no raw JSON dump, and source discipline for metadata claims.
