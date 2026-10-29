# Proposal

## Why

The run list of a client cannot show the step progress of a run (issue #778). `RunSummary` has no step counts, thus a person must open each run to see how far it is.

## What Changes

- Each run of `GET {A}/runs` and the run of `GET {A}/run/:runId` get `doneSteps`, `runningSteps`, and `totalSteps`.
- The route reads the counts of a page in one statement, through the harness helper `countStepsByRuns`. The harness change `count-run-steps` adds the helper.
- A failed count read gives a run with no counts, as a failed artifact count read does.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: a new requirement "A run summary gives the step counts of the run".

## Impact

- `cli/src/api/runs.ts`: three optional fields on `RunSummary`.
- `cli/src/server/routes/runs.ts`: a `countSteps` option, and the read in `summarizeRuns` and in the detail route.
- `cli/src/server/routes/runs.test.ts`.
- The cli needs a harness release that exports `countStepsByRuns`.
