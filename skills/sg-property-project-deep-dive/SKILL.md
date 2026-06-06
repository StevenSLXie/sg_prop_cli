---
name: sg-property-project-deep-dive
description: Use when a buyer asks for a deep-dive report on a Singapore private residential project, especially whether to buy a specific layout such as a 3-bedder. Combines sg-housing URA transaction evidence with external project metadata, listing checks, liquidity/turnover analysis, peer comparison, rental context, and an objective recommendation.
---

# Singapore Property Project Deep Dive

Build a client-ready deep-dive report for one private residential project. The goal is not to produce more data; it is to help a buyer decide whether a project and layout are worth pursuing.

Use this skill for questions like:

- "Do a deep dive on D'LEEDON 3-bedders."
- "Is Treasure at Tampines a good buy for a 3-bedder around 1.8m?"
- "Compare the liquidity and price trend of The Tapestry against nearby similar projects."

## Core Principle

Start from transaction evidence, then enrich with project metadata and current market context.

`sg-housing` MCP provides URA sale/rental transaction evidence. It does not provide bedroom count, exact unit number, stack, facing, renovation, floor plan, active asking prices, or total number of 3-bedroom units in a project.

Use external sources for:

- Unit mix and bedroom count.
- Floor plans and typical 3-bedroom sizes.
- Total unit count.
- TOP year and tenure if not clear from transaction rows.
- Current active listings and asking prices.
- MRT/school/amenity context.

Every external project metadata or listing claim must include source name + URL, or be marked `needs verification`.

## Clarifying Questions

Ask at most 1-3 focused questions only if the user brief is too broad.

Proceed without asking when the user provides a project name and either a layout, budget, or purpose. Use reasonable defaults and state them.

Useful clarifying questions:

- Target layout or size band, for example 3-bedder or 900-1200 sqft.
- Budget or max price.
- Self-stay vs investment.
- Whether the buyer cares more about liquidity, entry price, rental yield, school/MRT, or long-term hold.

Do not require every dimension before starting.

## Report Method

### 1. Define The Scope

Normalize:

- Project name.
- Target layout, if any.
- Budget and size band, if any.
- Transaction window. Default to 12 months for liquidity and 24-60 months for trend context.
- Peer set. If user did not give peers, choose nearby or same-district projects with similar tenure, age, market segment, and unit profile.

### 2. Build Transaction Evidence

Use `find_private_residential_sale_comparables`.

For the target project:

- First call with `project`, `output_mode: "summary"`, and recent window.
- If layout is specified but bedroom count is unavailable, filter or segment by `area_sqm` bands based on externally verified floor plans or cautious heuristics.
- Label any such segmentation as `area-band proxy, not verified bedroom count` in tables, recommendation text, and caveats.
- Fetch a small evidence row sample only after summary.

For rental/investment angle:

- Use `get_private_residential_rental_medians` or `find_private_residential_rental_contracts`.
- Estimate rough gross yield only when enough sale and rent evidence exists.

### 3. Verify Unit Mix And Layout Supply

For a layout-specific question such as 3-bedders:

- Search external project pages for unit mix, total units, and floor plans.
- Capture whether 3-bedroom unit counts are directly stated.
- If exact 3-bedroom count is unavailable, estimate only with a caveat and source the floor-plan/area basis.

Calculate layout liquidity when possible:

```text
layout_turnover_rate = last_12_month_layout_transactions / estimated_or_verified_layout_unit_count
```

If exact layout unit count is unavailable, report a proxy:

```text
project_turnover_rate = last_12_month_project_transactions / total_project_units
```

Interpretation guide:

- Below 1% annual turnover: very thin liquidity; transaction evidence is weak.
- 1-3%: low to moderate liquidity.
- 3-6%: healthy resale liquidity.
- Above 6%: active market, but check if activity is driven by distress, recent TOP, or investor churn.

Do not present turnover as precise if the denominator is estimated.

### 4. Price Trend And Peer Comparison

For the target project:

- Compare latest 12 months vs prior 12 months median price and median PSF.
- Show transaction count for each period.
- If sample size is small, say trend is indicative only.

For peers:

- Select 3-5 comparable projects.
- Use similar area/layout bands where possible.
- Compare median PSF, median quantum, transaction count, and direction of movement.

Avoid cherry-picking peers. Explain why each peer is comparable or why it is imperfect.

### 5. Active Listing Check

If listings are available from web/search:

- Gather active asking prices for the target layout and area band.
- Record listing source, URL, asking price, size, bedrooms, and any notable condition/floor/facing claims.
- Compare asking PSF to recent transacted PSF.
- Flag stale or duplicated listings.

If listings cannot be verified, say active listing check is not completed and continue with transaction evidence.

### 6. Recommendation

Give an objective recommendation, not a sales pitch.

Use a balanced frame:

- What supports buying.
- What argues for caution.
- What price range looks defensible from evidence.
- What must be verified before viewing/offering.
- Whether to shortlist, watch, or pass for now.

## Required Report Structure

1. Executive answer
   - Buy / shortlist / watch / pass, with confidence level.
   - State transaction window and sample size.

2. Project snapshot
   - Project, district, street, tenure, TOP, total units, market segment.
   - Source every external metadata claim or mark `needs verification`.

3. Target layout supply and liquidity
   - Verified or estimated layout unit count.
   - Last 12-month layout transactions.
   - Turnover rate or proxy turnover rate.
   - Liquidity interpretation.

4. Price evidence
   - Latest transaction range, median price, median PSF.
   - 12-month vs prior 12-month movement.
   - Evidence rows only if useful, capped at 5-10.

5. Peer comparison
   - 3-5 comparable projects.
   - Explain comparability.
   - Compare trend, liquidity, price/PSF.

6. Active listings
   - Current asking evidence if available.
   - Compare asking vs transacted.
   - Flag if listing data is incomplete or stale.

7. Recommendation and negotiation frame
   - Suggested bid discipline.
   - Fair range from evidence.
   - Red flags and due diligence.

8. Sources and caveats
   - URA transaction data via sg-housing.
   - External source names + URLs.
   - State that URA rows do not include bedroom count or unit-level attributes.
   - State that this is decision support, not valuation advice.

## Output Rules

- Be objective and fair. Do not write like a selling brochure.
- Do not dump raw JSON.
- Do not infer bedroom count solely from URA rows.
- Do not present exact turnover unless both numerator and denominator are defensible.
- If evidence is thin, say so plainly.
- Keep tables compact and readable.
- Show enough evidence to support the recommendation, not every row.

## Minimum Quality Bar

A good report must include:

- Transaction window and sample size.
- Layout/bedroom caveat if layout-specific.
- Liquidity or turnover analysis.
- Price trend comparison.
- Peer comparison.
- Listing check or explicit statement that listing check was not completed.
- Source name + URL for external metadata claims, or `needs verification`.
- Balanced recommendation with watch-outs.
- Not valuation advice.
