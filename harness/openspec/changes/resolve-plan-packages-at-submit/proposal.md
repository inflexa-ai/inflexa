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

- `validatePlan` takes optional package sources: a pool index and an image base.
  When the sources are given, the validation resolves each entry with
  `resolvePackage`. It refuses `ambiguous` with the two prefixed forms. It
  refuses `unknown`, with the suggestion of the ladder when there is one. It
  refuses a wrong pin of a base package. Without the sources, the validation is
  the same as before.
- The inventory read carries its own scope and its own sources. The planner
  takes the sources from the pool census that it reads for its seed, and it
  gives them to `submit_plan`. The pre-launch validation of a stored plan takes
  no sources. The link pass stays.
- The image record `image-packages.json` carries two new additive fields:
  `r_base`, the names of the base R packages, and `python_stdlib`, the public
  names of the Python standard-library modules. The schema number stays 1.
- `resolvePackage` resolves over the pool first, then over the pool and the
  image. The validator and the link pass of the embedder both call it. Thus the
  two readers give one answer for each entry.
- The seam contract carries a package of the image: `present` covers a base
  package, and a `collision` claim can be a runtime of the image.
- The string grammar of an entry does not change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `planning-enhancements`: the plan validation resolves each entry against the
  sources that the planner gives. The launch refusal names two claims.
- `package-identity`: two pool indexes join into one index, and a package
  resolves over the pool first, then over the image.
- `harness-sandbox-agents`: `present` covers a base package of the image, and a
  `collision` claim can be a runtime of the image.
- `sandbox-image-catalog`: the image record carries `r_base` and
  `python_stdlib`.

## Impact

- `harness/src/schemas/validate-plan.ts`: the resolution step and its issue text.
- `harness/src/tools/research/generate-plan.ts`: the census index and its path to
  `fullyValidate`.
- `harness/src/tools/sandbox/list-available-packages.ts`: the census read
  carries its scope and its sources.
- `harness/src/sandbox/package-identity.ts`: `poolIndexOver` and
  `joinPoolIndexes`.
- `harness/src/sandbox/image-packages.ts`: the two optional fields,
  `imageBaseOf`, and `resolvePackage`.
- `harness/src/sandbox/types.ts`, `harness/src/tools/execute-analysis.ts`,
  `harness/src/tools/sandbox/link-packages.ts`, and
  `harness/src/prompts/sandbox-standards.ts`: the widened seam contract.
- `harness/src/index.ts`: the exports that the embedder uses.
- `images/sandbox-base/scripts/image-record.py`: the two fields.
- The companion cli change `resolve-plan-packages-at-submit`: the link pass of
  the cli calls `resolvePackage`, and it answers `present` for a package that
  only the image holds.
