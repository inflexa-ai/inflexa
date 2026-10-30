# Proposal

## Why

A host cannot give a count of the run outputs of an analysis that agrees with the counts of its runs (issue #736). The paged ledger read selects each row of the analysis, `input` rows included, but the grouped run count counts the `step_output` rows only. A host also cannot list the plans of an analysis (issue #737). The harness reads one plan by its id, thus a host must walk the transcript to find the newest plan.

## What Changes

- The paged ledger read of an analysis takes an optional `role` filter, `input` or `step_output`. The filter selects the entries, and `total` and `extensionCounts` count the same rows.
- A new read gives one page of the plans of an analysis, newest first, with the exact count of the plans. Each entry gives these fields:
  - the plan id, the creation time, and the title
  - the parent plan id and `supersededBy`
  - the id of the newest run of the plan, or `null`
- The package root exports the new read and its types.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `artifact-manifest`: the requirement "One read gives a page of the artifact ledger of an analysis" adds the `role` filter.
- `plan-reads`: a new requirement for the page of the plans of an analysis. The requirement "The package root exports the plan reads" adds the page read.

## Impact

- `harness/src/state/artifacts.ts`, `harness/src/state/plans.ts`, `harness/src/state/index.ts`, `harness/src/index.ts`.
- Tests in `harness/src/state/test/artifacts.page.test.ts`, `harness/src/state/test/plans.test.ts`, and `harness/src/state/test/plan-reads.barrel.test.ts`. The first two use Postgres.
- No migration. The existing indexes serve the new read.
- The cli uses the filter and the read in its change `filter-artifacts-by-role-and-list-plans`.
