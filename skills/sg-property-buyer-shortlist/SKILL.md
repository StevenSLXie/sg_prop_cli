---
name: sg-property-buyer-shortlist
description: Use when a buyer asks what Singapore private residential projects fit a budget, district/location, size, bedroom, tenure, MRT/school, self-stay, or investment brief. Produces a client-ready shortlist report using sg-housing transaction evidence plus external project metadata when needed.
---

# Singapore Property Buyer Shortlist

Build a client-ready shortlist for a buyer. This is a report workflow, not just an MCP calling guide.

Use this skill for questions like:

- "D18, 1.6-2.2m, 900-1200 sqft, what condos should I consider?"
- "D9 with 3M budget, can I afford a 3-bedder freehold?"
- "Near good MRT, around 2m, investment angle, shortlist projects."

## Core Principle

Use `sg-housing` MCP as the transaction evidence source. Do not treat it as the only source of truth.

Use external sources when the report needs project facts not present in URA transaction rows, such as bedroom count, TOP year, developer, facilities, MRT distance, school proximity, exact layouts, or whether an area band corresponds to a 2-bedder/3-bedder in that project.

If external sources are unavailable or inconsistent, say what was verified and what still needs verification. Do not invent project metadata.

## Inputs To Extract

Extract and normalize these fields before querying:

- Budget: min/max SGD. If only one number is given, treat it as max budget unless wording says otherwise.
- Location: district, town, planning area, MRT, school, or region. Normalize district to a two-digit string when using URA tools, for example `18`.
- Size: convert sqft to sqm using `sqm = sqft / 10.7639`. Keep both units in the report.
- Bedroom count: treat as a desired layout, not a field guaranteed by URA transactions.
- Tenure: freehold, 999-year, 99-year, leasehold, or no preference.
- Property type: condo, apartment, EC, landed, or no preference.
- Use case: self-stay, investment, rental yield, school, commute, or value.
- Must-haves and exclusions.

Default assumptions when the user does not specify:

- Transaction window: start with the past 24 months. If sample size is too small, expand to 36 or 60 months and state that you expanded it.
- Sale type: `resale` for resale buyer shortlist questions.
- Output: 5-8 candidate projects, then 3-5 strongest next-step projects.

## Clarifying Questions

Ask a clarifying question when the brief is too ambiguous to build a useful shortlist. Do not require every input dimension to be filled.

Proceed without asking when the user provides enough to form a bounded search, usually:

- budget plus location, or
- budget plus size/layout, or
- location plus size/layout and a clear use case.

Ask at most 1-3 focused questions. Prefer the smallest set that changes the search materially:

- Budget range or max budget, if missing.
- Target location, district, MRT, school, or region, if missing.
- Size or bedroom target, if missing and the shortlist would otherwise be too broad.
- Use case, if the ranking depends on self-stay vs investment.

Do not ask for all of budget, district, size, bedroom, tenure, property type, use case, MRT, school, and exclusions in one turn. If only minor details are missing, make reasonable assumptions, state them, and continue.

## Data Acquisition Plan

1. Query transaction candidates first.
   - Use `find_private_residential_sale_comparables`.
   - Use `output_mode: "summary"` first.
   - Use filters for `district`, `min_price`, `max_price`, `min_area_sqm`, `max_area_sqm`, `type_of_sale`, `property_type`, and `from/to` where applicable.
   - For sqft criteria, convert before calling the tool. Example: 900-1200 sqft -> about 84-111 sqm.
   - Read `summary.sample_size` and `summary.project_summaries`.

2. Decide if evidence is sufficient.
   - If `sample_size >= 30`, use the summary as the main candidate pool.
   - If `sample_size` is small but non-zero, expand time window or relax one non-critical filter.
   - If `sample_size` is zero, explain which constraint likely caused it and retry with one relaxed constraint.

3. Fetch evidence rows only for likely candidates.
   - For top projects, call `find_private_residential_sale_comparables` with `project`, same price/area filters, `output_mode: "both"`, and a small `limit` such as 10-20.
   - Do not fetch rows for every possible project unless the candidate set is very small.

4. Verify project metadata externally when needed.
   - Bedroom count is not in URA private sale transaction rows.
   - Use web or other available sources for project-level facts: TOP, tenure, bedroom layouts, typical unit sizes, MRT, schools, developer, amenities.
   - Cross-check when possible. If a source is stale or not authoritative, phrase carefully.
   - Every external project metadata claim must include a source name and URL, or be marked `needs verification`.

5. Optional rental context.
   - For investment questions, call rental median or rental contract tools for top projects.
   - Gross yield is rough: annual rent / purchase price. State that it excludes fees, taxes, vacancy, repairs, loan costs, and management costs.

## Ranking Logic

Rank projects by a practical mix of:

- Fit to budget and size range.
- Transaction sample size and liquidity.
- Median price and median PSF.
- Area consistency with the desired bedroom count.
- Tenure and age fit.
- Location fit to the user's stated priorities.
- Rental context if investment-oriented.
- Any obvious watch-outs.

Do not rank solely by cheapest PSF. Cheap can mean older, less liquid, less convenient, lease concern, or project-specific issues.

## Required Report Structure

Use this structure unless the user asks for a very brief answer:

1. Brief answer
   - State whether the brief is feasible.
   - Mention time window and sample size.

2. Shortlist table
   - Project
   - Street / area
   - Transaction count
   - Price range
   - Median price
   - Median PSF
   - Typical area range
   - Fit note

3. Recommended next-step projects
   - Pick 3-5.
   - For each, explain why it is worth viewing or investigating.

4. Watch-outs
   - Bedroom count requires layout verification if inferred from area.
   - Tenure/TOP/project facts require external verification if not directly sourced.
   - Small sample sizes are weaker evidence.
   - URA records do not include unit numbers, facing, stack, renovation, or bedroom count.

5. Evidence and caveats
   - Name the data source categories used.
   - For every external project metadata claim, include source name + URL. If not sourced, mark it `needs verification`.
   - State transaction window, filters, and sample size.
   - Say clearly that this is decision support, not valuation advice.

## Output Rules

- Keep the main answer concise and client-readable.
- Avoid dumping raw JSON or more than 10 evidence rows.
- Do not include every matching project if the list is long. Summarize and shortlist.
- Use SGD and PSF consistently.
- Use approximate signs for inferred values.
- Do not overstate certainty when bedroom count is inferred from area.
- Do not present TOP, bedroom layout, MRT distance, school proximity, developer, or tenure as verified unless you cite a source name and URL.

## Failure Handling

If the sg-housing MCP call fails:

- Retry once with a narrower query or `output_mode: "summary"`.
- If rate-limited or upstream unavailable, say the data source is temporarily unavailable and provide a lighter plan.
- Do not switch to unsupported claims from memory.

If external metadata is unavailable:

- Continue with transaction-based shortlist.
- Mark bedroom/TOP/tenure details as "needs verification".

## Minimum Quality Bar

A good report must include:

- Converted area range when the user gives sqft.
- Clear transaction window.
- Sample size.
- Candidate project table.
- At least one caveat about bedroom count or missing unit-level details.
- Evidence-based recommendation, not generic neighborhood commentary.
