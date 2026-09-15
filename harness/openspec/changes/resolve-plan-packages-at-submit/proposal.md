## Why

`submit_plan` parses each package entry, but it does not resolve the entry
against the pool. Thus a bare name that both tracks hold, or a name that the
pool does not hold, passes the submit and refuses at the launch. The planner
never sees that refusal in its loop. An experiment of 2026-09-05 on
`claude-haiku-4-5` measured the result: half of the accepted plans refuse at
the launch (issue #512).

A base R package such as `stats`, and a Python standard-library module such
as `json`, are not in the pool. The image holds them. Thus the ladder answers
`unknown`, and the launch refuses a plan that names one.

## What Changes

- `validatePlan` takes an optional `PoolIndex`. When the index is given, the
  validation resolves each entry with `resolveQuery`. It refuses `ambiguous`
  with the two prefixed forms. It refuses `unknown`, with the suggestion of the
  ladder when there is one. Without the index, the validation is the same as
  before.
- The planner builds the index from the pool census that it reads for its seed,
  and it gives the index to `submit_plan`. The pre-launch validation of a stored
  plan takes no index. The link pass stays.
- The image record `image-packages.json` carries two new additive fields:
  `r_base`, the names of the base R packages, and `python_stdlib`, the names of
  the Python standard-library modules. The schema number stays 1.
- The harness makes a pool index from the two fields of the record, and it
  joins two pool indexes into one. The planner index and the link pass of the
  embedder both join the image index to the pool index. Thus the validator and
  the link pass give one answer for each entry.
- The string grammar of an entry does not change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `planning-enhancements`: the plan validation resolves each entry against the
  pool when the planner gives an index. The planner builds that index from its
  census.
- `package-identity`: two pool indexes join into one index. The image record
  gives a pool index of the base R packages and the Python standard-library
  modules.
- `sandbox-image-catalog`: the image record carries `r_base` and
  `python_stdlib`.

## Impact

- `harness/src/schemas/validate-plan.ts`: the resolution step and its issue text.
- `harness/src/tools/research/generate-plan.ts`: the census index and its path to
  `fullyValidate`.
- `harness/src/tools/sandbox/list-available-packages.ts`: the census read gives
  the record, and a function builds the census index.
- `harness/src/sandbox/package-identity.ts`: `joinPoolIndexes`.
- `harness/src/sandbox/image-packages.ts`: the two optional fields and
  `imagePoolIndex`.
- `harness/src/index.ts`: the exports that the embedder uses.
- `images/sandbox-base/scripts/image-record.py`: the two fields.
- The companion cli change `resolve-plan-packages-at-submit`: the link pass of
  the cli joins the image index, and it answers `present` for a package that
  only the image holds.
