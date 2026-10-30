# Proposal

## Why

The "Results" count of a client comes from `GET {A}/artifacts` with no `runId`. That count includes each `input` row of a data profile, but the `artifactCount` of a run counts only the run outputs (issue #736). Thus the two numbers do not agree. Also, no route lists the plans of an analysis (issue #737). A client must walk the paged transcript to find the latest plan, and it cannot list the older plans.

## What Changes

- `GET {A}/artifacts` takes the query value `role`, `input` or `step_output`. The filter applies to the items, to `total`, and to `extensionCounts`. A different value gets 400 `validation_error`.
- New route `GET {A}/plans`: one page of the plans of the analysis, newest first, in the list shape with the key `plans`. Each item gives these fields:
  - `planId`, `createdAt`, and `title`
  - `parentPlanId` and `supersededBy`
  - `newestRunId`, or `null` for a plan with no run
- The list has no filter by thread.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the requirement "The server lists the artifact ledger of an analysis" adds the `role` query value. A new requirement "The server lists the plans of an analysis" gives `GET {A}/plans`. The requirement "The routes group by domain and keep the Cortex path tail" adds the plans to the runs group.

## Impact

- `cli/src/server/routes/artifacts.ts`, `cli/src/server/routes/runs.ts`, and `cli/src/api/runs.ts`.
- Tests in `cli/src/server/routes/artifacts.test.ts` and `cli/src/server/routes/runs.test.ts`.
- The routes use the harness change `filter-artifacts-by-role-and-list-plans`: the `role` filter of `queryArtifactPage`, and the new read `queryPlanPage`.
- No client fetcher. The client that reads these routes is not in this repository.
