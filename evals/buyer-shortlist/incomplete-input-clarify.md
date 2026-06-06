# Eval Case: Incomplete Buyer Brief Clarification

## Prompt

```text
I want to buy a condo in Singapore. What should I shortlist?
```

## Expected Behavior

- Ask a small number of clarifying questions before querying.
- Do not ask for every possible dimension.
- Prioritize questions that materially bound the search:
  - budget or max budget
  - target location or district/MRT/school
  - size or bedroom target
  - self-stay vs investment only if needed for ranking
- Keep it easy for the user to answer.

## Acceptable Response Shape

```text
I can shortlist, but this is too broad. To make it useful, what is your max budget and preferred area/district/MRT? If you already know the size or bedroom target, include that too.
```

## Failure Modes

- Running a broad transaction query with no budget or location.
- Asking the user to fill out a long intake form.
- Refusing to help unless every dimension is specified.
