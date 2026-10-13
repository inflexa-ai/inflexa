# Proposal

## Why

GitHub issue #649: the run row holds its plan id (`src/server/routes/runs.ts:192`), but no run read gives it (`src/api/runs.ts:33-50`). The run detail gives only the ledger steps, with no dependencies and no levels (`src/api/runs.ts:60-88`). Thus a client draws the graph of a finished run only after a replay of its stream. A step with no ledger row is absent. No route gives a plan by its id, or the plan that replaced it.

The harness change `give-the-plan-to-the-run-reads` gives the lineage read, the run id read, the plan graph, and the `data-plan` part of a stored plan. This companion change connects them to the routes of the local server.

## What Changes

- Each run of `GET {A}/runs` and the run of `GET {A}/run/:runId` give `planId`, or `null` for a run with no plan.
- `GET {A}/run/:runId` gives `plan`: `{ planId, steps }`, where each step has `id`, `name`, `agent`, `dependsOn`, and `level`. It is `null` when the run has no plan, or when the plan is gone or unreadable. A plan step with no ledger row is a step that did not start.
- `GET {A}/plans/:planId` gives the `data-plan` part of the plan, `parentPlanId`, `supersededBy`, and the ids of its runs, newest first, under a fixed limit. A flag tells when the plan has more runs. A plan whose document does not parse gives its lineage and its runs, with no part.
- The route-group list of the `local-server` spec names one plan.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the run reads give the plan of the run, the routes of `{A}` get one plan, and the route-group list names it.

## Impact

- cli code: `src/api/runs.ts`, `src/server/routes/runs.ts`, the route tests, and each test fixture that builds a `RunSummary` or a `RunDetail`.
- The harness: the routes use the reads of the harness change, thus `bun run harness:local` comes before the typecheck and the tests.
- No client fetcher and no TUI change. The consumer is the web client, the same as for `GET {A}/run/:runId/synthesis`.
