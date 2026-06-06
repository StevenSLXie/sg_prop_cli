---
name: sg-property-client-report
description: Use when a buyer, renter, investor, or property agent asks for Singapore private residential advice, from a broad budget/location/layout brief to a specific condo/project deep dive. Produces an objective client-ready report using sg-housing URA sale/rental evidence plus external project metadata, listings, layout checks, liquidity, peer comparison, and recommendation.
---

# Singapore Property Client Report

Build a client-ready Singapore private residential report. The user may start with a broad buying brief, a specific project, a layout question, or a project comparison. Treat all of these as one workflow: clarify the client objective, collect evidence, compare alternatives, then give a fair recommendation.

Use this skill for questions like:

- "D18, 1.6-2.2m, 900-1200 sqft, what condos should I consider?"
- "Do a deep dive on D'LEEDON 3-bedders."
- "Is Treasure at Tampines a good buy for a 3-bedder around 1.8m?"
- "Compare The Tapestry and The Alps for self-stay and resale liquidity."
- "For a client with 2.2m budget, which projects should I show and why?"

## Core Principle

Do not just return data. Build a defensible recommendation.

Start from transaction evidence, then enrich it with project facts, layout reality, active asking context, location fit, and risks. `sg-housing` MCP is the evidence base for URA sale/rental transactions; it does not provide bedroom count, unit number, stack, facing, renovation, exact floor plan, exact active listings, or complete unit-mix counts.

Every external project metadata or listing claim must include source name + URL, or be marked `needs verification`.

## Report Modes

Choose the mode from the user brief:

- **Buyer brief / shortlist**: user gives budget, district/location, size, layout, tenure, MRT/school, self-stay, or investment criteria. Produce a market map, then shortlist 3-5 projects for deeper follow-up.
- **Project deep dive**: user names a project and asks whether to buy, view, bid, or avoid. Produce a full project report.
- **Project comparison**: user names 2+ projects. Use the same sections for each, then compare fit and trade-offs.
- **Investment/rental check**: user cares about rent or yield. Add rental medians/contracts and rough gross yield, with cost caveats.

If the brief starts broad, do not stop at a shallow shortlist. Pick the strongest 2-3 candidates and give enough depth for a client conversation.

## Clarifying Questions

Ask at most 1-3 focused questions only if the brief is too broad to bound the search. Do not require every dimension before starting.

Proceed without asking when the user provides enough to form a bounded report, usually:

- budget plus location,
- budget plus size/layout,
- project plus layout/budget/purpose,
- project comparison plus use case.

Useful questions:

- Max budget or comfortable range.
- Target location, MRT, school, or district.
- Size/layout target, for example 3-bedder or 900-1200 sqft.
- Self-stay vs investment.
- Priority: liquidity, entry price, rental yield, schools, commute, long-term hold, or upgrade exit.

State assumptions when proceeding with incomplete input.

## Research Workflow

### 1. Define The Client Lens

Normalize:

- Buyer/renter/investor objective.
- Budget, treating a single number as max budget unless wording says otherwise.
- Location: district, planning area, MRT, school, street, or region.
- Size: convert sqft to sqm using `sqm = sqft / 10.7639` and keep both units in the report.
- Layout: treat bedroom count as desired layout, not a URA field.
- Tenure, age/TOP, property type, rental/yield needs, must-haves, exclusions.

Default windows:

- 12 months for liquidity and current price action.
- 24 months for shortlist screening.
- 24-60 months for longer trend context when sample size is thin.

### 2. Build The Transaction Base

Use `find_private_residential_sale_comparables`.

For broad buyer briefs:

- Start with `output_mode: "summary"`.
- Use filters for district/location, min/max price, min/max area sqm, property type, tenure proxy if available, sale type, and from/to.
- Use `summary.project_summaries` to identify candidate projects.
- If sample size is zero, relax one non-critical constraint and explain the retry.
- Fetch rows only for shortlisted projects, capped to a small evidence sample.

For project reports:

- Query the target project first with recent windows.
- Fetch peer projects with similar district/location, age, tenure, unit profile, market segment, or buyer audience.
- Fetch row samples only after summary statistics.

For investment:

- Use `get_private_residential_rental_medians` or `find_private_residential_rental_contracts`.
- Estimate gross yield only when both sale and rent evidence are sufficient.

### 3. Verify Project And Layout Reality

Use external sources for:

- total units, TOP/completion year, tenure, developer,
- unit mix, floor plans, typical sizes, bedroom count,
- site plan, stack/facing/noise/road exposure where available,
- facilities, maintenance/lifestyle fit,
- MRT, schools, malls, parks, commute,
- active listings and asking prices.

When layout is specified but bedroom count is unavailable in URA:

- Prefer externally verified floor plans and unit mix.
- If using `area_sqm` as a proxy, label it exactly: `area-band proxy, not verified bedroom count`.
- Do not claim exact bedroom transaction count from URA alone.

### 4. Analyze Liquidity

For layout-specific questions:

```text
layout_turnover_rate = last_12_month_layout_transactions / verified_or_defensible_layout_unit_count
```

If the layout denominator is unavailable:

```text
project_turnover_rate = last_12_month_project_transactions / total_project_units
```

Interpretation:

- Below 1% annual turnover: very thin liquidity; transaction evidence is weak.
- 1-3%: low to moderate liquidity.
- 3-6%: healthy resale liquidity.
- Above 6%: active market; check if driven by recent TOP, investor churn, or distressed exits.

Do not present turnover as precise if the denominator is estimated.

### 5. Price, Peer, And Listing Checks

For price trend:

- Compare latest 12 months vs prior 12 months median price and median PSF.
- Show transaction count for each period.
- If sample size is small, say trend is indicative only.

For peers:

- Pick 3-5 comparable projects.
- Explain why each peer is comparable and where it is imperfect.
- Compare median PSF, median quantum, transaction count, liquidity, tenure/age, and buyer profile.
- Avoid cherry-picking peers to force a conclusion.

For active listings:

- Capture source name, URL, asking price, size, bedrooms, and notable claims.
- Compare asking PSF to recent transacted PSF.
- Treat listings as asking context, not transaction evidence.
- Flag stale, duplicated, or unverifiable listings.

## Report Structure

Use this structure for full answers. For short answers, preserve the same logic but compress sections.

1. Executive answer
   - Shortlist / watch / pass / proceed to viewing / negotiate only below X.
   - Confidence level, transaction window, sample size.

2. Client brief and assumptions
   - Budget, location, layout, use case, must-haves.
   - Missing inputs and assumptions.

3. Market map or project snapshot
   - For broad briefs: candidate pool and why projects were included/excluded.
   - For project reports: project, street, district, tenure, TOP, total units, market segment, developer.
   - Source every external claim or mark `needs verification`.

4. Location and living fit
   - MRT/commute, schools, amenities, roads/noise, daily usability.
   - Separate verified facts from judgement.

5. Unit mix, layout, and stack/site considerations
   - Layout supply, typical sizes, floor-plan fit, site/stack/facing risks if known.
   - Mark area-band proxies clearly.

6. Liquidity and turnover
   - Layout turnover if defensible; otherwise project turnover proxy.
   - Explain what liquidity means for exit risk and price discovery.

7. Price evidence
   - Latest range, median price, median PSF.
   - 12-month vs prior 12-month movement.
   - Evidence rows only if useful, capped at 5-10.

8. Peer comparison
   - 3-5 peers with comparability notes.
   - Show price, liquidity, tenure/age, and buyer-fit trade-offs.

9. Active listings and negotiation frame
   - Current asking evidence if available.
   - Asking vs transacted gap.
   - Fair range and bid discipline.

10. Recommendation
   - What supports buying.
   - What argues for caution.
   - Who this is suitable for and who should avoid it.
   - Due diligence before viewing or offering.

11. Sources and caveats
   - URA transaction data via sg-housing.
   - External source names + URLs.
   - URA rows do not include bedroom count, unit number, stack, facing, renovation, or exact layout.
   - Decision support, not valuation advice.

## Output Rules

- Be objective and fair. Do not write like a sales brochure.
- Do not dump raw JSON.
- Keep tables compact and readable.
- Do not include every matching row or project when the list is long.
- Use SGD and PSF consistently.
- For sqft criteria, show sqm conversion.
- Do not rank solely by cheapest PSF.
- If evidence is thin, say so plainly.
- If external sources conflict, show the conflict instead of choosing silently.

## References

Load these only when needed:

- `references/report-template.md` for the full report skeleton.
- `references/source-map.md` for source categories and URL capture checklist.
- `references/turnover-methodology.md` for liquidity calculations.
- `references/research-patterns.md` for Stacked-style depth cues and report dimensions.

## Minimum Quality Bar

A good report must include:

- Transaction window and sample size.
- Clear recommendation, not just data.
- Layout/bedroom caveat when layout-specific.
- Liquidity or turnover analysis.
- Price trend and peer comparison.
- Active listing check or explicit statement that it was not completed.
- Source name + URL for external metadata/listing claims, or `needs verification`.
- Watch-outs and due diligence.
- Not valuation advice.
