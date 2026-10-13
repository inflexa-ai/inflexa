# Proposal

## Why

GitHub issue #647: the Results page of the web client shows each file of an analysis, the synthesis of a run, and the result counts. The local server gives no list of the artifact ledger, no artifact count of a run, and no read of the synthesis. Thus a client replays the run stream at each open of the results.

The harness change `list-the-artifacts-and-read-the-synthesis` gives the reads. This companion change connects them to the routes of the local server.

## What Changes

- `GET {A}/artifacts` gives one page of the artifact ledger in the list shape, with the key `artifacts`. Each entry gives `path`, `size`, `fileType`, `role`, `runId`, `stepId`, and `createdAt`. The query takes `runId`, `stepId`, `fileType`, `q`, `sort=path|recent`, `page`, and `perPage`.
- Each run summary of `GET {A}/runs` and the run of `GET {A}/run/:runId` give `artifactCount`, the count of the step outputs of the run. One grouped read serves each page of runs.
- `GET {A}/run/:runId/synthesis` gives `{ status, reason, synthesis }`. `status` and `reason` are the synthesis outcome of the run row. `synthesis` is the flat `data-run-synthesis` part from the record on disk, or `null`.
- The route-group list of the `local-server` spec names the synthesis of a run.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the routes of `{A}` get the artifact list and the synthesis of a run, and the run summary gets the artifact count.

## Impact

- cli code: `src/server/routes/artifacts.ts`, `src/server/routes/runs.ts`, `src/server/app.ts`, `src/api/artifacts.ts`, `src/api/runs.ts`, and the tests of the two route files.
- The harness: the routes use the reads of the harness change, thus `bun run harness:local` comes before the typecheck and the tests.
- No client fetcher. The consumer is the web client, the same as for `GET {A}/files`.
