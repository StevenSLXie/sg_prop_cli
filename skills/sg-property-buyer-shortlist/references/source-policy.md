# Source Policy

## Transaction Evidence

Use `sg-housing` MCP for transaction evidence:

- `find_private_residential_sale_comparables`
- `find_private_residential_rental_contracts`
- `get_private_residential_rental_medians`
- `get_private_developer_sales`

Use summary first. Fetch rows only for shortlisted projects or when examples are needed.

## External Metadata

Use external sources for facts that are not in URA private sale rows:

- Bedroom count and layouts.
- TOP year.
- Tenure when the transaction source is ambiguous.
- Developer and project details.
- MRT distance, schools, facilities, and amenities.

Prefer official or primary-ish sources where available. If using listing portals or secondary pages, do not treat stale listing data as authoritative.

## Claim Discipline

- If verified, state it plainly.
- If inferred from area, say "likely" or "area band suggests".
- If not verified, say "needs verification".
- Do not fabricate project facts to make the report look complete.
- Every verified project metadata claim must include source name + URL.
- If no source name + URL can be provided, mark the claim `needs verification`.
