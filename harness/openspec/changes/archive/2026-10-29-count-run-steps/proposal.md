# Proposal

## Why

A list of runs cannot show the step progress of each run (issue #778). The harness counts the steps only for the newest run of each analysis, and it does not count the steps that run now. The cli run list must read the counts of all runs of a page in one statement.

## What Changes

- Add `countStepsByRuns(pool, analysisId, runIds)` to the step execution helpers. It gives the done, the running, and the total step count of each run of a list, in one statement.
- Export the helper and its row type from the package entry, as `countArtifactsByRuns` is exported.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `step-execution-tracking`: the requirement "Step execution query helpers" adds `countStepsByRuns`.

## Impact

- `harness/src/state/step-executions.ts`, `harness/src/state/index.ts`, `harness/src/index.ts`.
- A new test in `harness/src/state/test/step-executions.test.ts`. It needs Postgres.
- The cli uses the helper in the change `run-summary-step-counts`.
