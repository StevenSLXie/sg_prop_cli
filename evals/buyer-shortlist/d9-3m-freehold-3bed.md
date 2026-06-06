# Eval Case: D9 Freehold 3-Bedder Feasibility

## Prompt

```text
D9 with 3M budget, can one afford a 3 bedded freehold, regardless TOP year? Give me a very brief project list using recent transaction data.
```

## Expected Behavior

- Interpret 3M as max budget unless user says otherwise.
- Use recent URA private sale transactions as evidence.
- Filter D9 and max price around 3,000,000.
- Use tenure/freehold as a required preference, but verify tenure from transaction rows and/or external metadata.
- Recognize that bedroom count is not in URA rows.
- Use area bands and external project/floorplan metadata to assess whether candidates are plausible 3-bedders.
- Keep output brief, with a compact project list.
- Include transaction window, sample size, and caveats.

## Failure Modes

- Presenting leasehold projects as freehold.
- Treating all 900+ sqft units as 3-bedders without caveat.
- Overloading the answer with raw transaction rows.
- Omitting evidence window and sample size.
