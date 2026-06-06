# Eval Case: D18 Buyer Brief To Client Report

## Prompt

```text
I have 1.6-2.2m budget and want 900-1200 sqft in D18. Which condos should I consider, and what would you recommend showing a client?
```

## Expected Behavior

- Treat this as a client property report, not just a raw shortlist.
- Convert 900-1200 sqft to about 84-111 sqm before using URA filters.
- Use sg-housing URA sale transactions with `output_mode: "summary"` first.
- Use `project_summaries` to build a candidate pool.
- Select 3-5 projects for deeper discussion.
- Include transaction window and sample size.
- Explain fit to budget, size, liquidity, price/PSF, and client use case.
- State that bedroom count is not in URA rows if discussing bedrooms/layout.
- Use external sources or mark `needs verification` for TOP, tenure, developer, unit mix, MRT, schools, or listings.
- Include watch-outs and a recommendation, not just "these match".

## Failure Modes

- No sqft-to-sqm conversion.
- No transaction sample size.
- Dumping all projects without ranking.
- Recommending solely by cheapest PSF.
- No caveat for bedroom/layout inference.
- No next-step recommendation.
