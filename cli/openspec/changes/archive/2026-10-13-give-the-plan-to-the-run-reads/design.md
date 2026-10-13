# Design

## Context

- `toRunSummary` (`src/server/routes/runs.ts:519-535`) maps the run row. The row has `planId`, and the summary drops it.
- The detail route reads the stored plan one time (`src/server/routes/runs.ts:192`). It uses the document for the title and the step names (`planTitleOf`, `planStepNames`). A failed read degrades through `unwrapOr(null)`.
- `RunRoutesOpts` (`src/server/routes/runs.ts:87-126`) holds each harness read, thus the route tests replace each read with a fake. `UNEXPECTED` in `src/server/routes/runs.test.ts:69-86` and the literal in `src/server/routes/attention.test.ts` list each field.
- The harness change gives `loadPlanRecord`, `queryRunIdsByPlan`, `planGraphOf`, `planPartOf`, and the types `PlanRecord` and `PlanGraphStep`.

## Goals / Non-Goals

**Goals:**

- The run reads give the plan id and the plan graph. The run list gets no new read, and the detail gets no second plan read.
- One route gives a plan, its lineage, and its runs, with a fixed count of reads.

**Non-Goals:**

- No client fetcher, no TUI change, and no change of `RunStepSummary`.
- No change of the plan title and the step names of the run reads.

## Decisions

### D1. The plan id of a run summary

`RunSummary` gets `planId: string | null`, after `threadId`. `toRunSummary` copies `row.planId`. The list sends no new read.

### D2. The plan graph of a run detail

`RunDetail` gets `plan: RunPlan | null`. `RunPlan` is `{ planId: string; steps: PlanGraphStep[] }`. `src/api/runs.ts` imports `PlanGraphStep` as a type from `@inflexa-ai/harness/contracts/index.js`, thus a client loads no harness code.

The detail route keeps its one plan read. It gives the document that it reads to `planGraphOf`:

- `run.planId === null`, or the document is `null`: `plan` is `null`.
- `planGraphOf(document)` is `null`: `plan` is `null`.
- Else `plan` is `{ planId: run.planId, steps }`.

`planGraphOf` is a pure harness function, thus `RunRoutesOpts` gets no field for it. The levels are the levels of `data-dag-state`, because the harness uses one algorithm for the two.

### D3. One plan with its lineage and its runs

Add `GET /plans/:planId` to `runRoutes`, behind the runtime gate. The cli keeps a route of a single caller in its file, and the spec lists the plan in the runs group.

`RunRoutesOpts` gets two reads:

- `loadPlanRecord(pool, planId, analysisId)`, with the default `loadPlanRecord(pool, planId, { analysisId })`
- `listPlanRunIds(pool, analysisId, planId, limit)`, with the default `queryRunIdsByPlan(pool, { analysisId, planId, limit })`

The route sends the two reads at the same time. The run read gets the limit `PLAN_RUN_IDS_LIMIT + 1`, with `PLAN_RUN_IDS_LIMIT = 100`, the same as the thread run list reads one row past its page (`src/server/routes/runs.ts:441-444`). Then the route does these steps:

1. A failed read gives 500 `internal_error`.
2. A `null` record gives 404 `not_found` with the message `This analysis has no plan <planId>.`.
3. Else the body is `PlanView`: `{ plan: PlanPart | null; parentPlanId: string | null; supersededBy: string | null; runIds: string[]; hasMoreRuns: boolean }`.
4. `plan` is `planPartOf(record)`. When it is `null`, the route logs a warning. The plan row exists, thus the route degrades and does not give 404 (the cli rule "never fail hard" on local state).
5. `runIds` is the first 100 ids, and `hasMoreRuns` is true when the read gave 101.

`PlanView` is in `src/api/runs.ts`. `plan` is the harness contract part, as `synthesis` of `RunSynthesisView` is.

`parentPlanId` is also a field of the part, when the plan has a parent. The body gives it at the top level too, because the issue names it beside `supersededBy`. The pair at the top level gives the lineage with no read of the card.

The limit of 100 bounds the body, and `hasMoreRuns` tells a client that older runs exist. One plan rarely has more runs than that, because each run is a full analysis. The harness index on `(analysis_id, plan_id, started_at DESC, run_id DESC)` bounds the read.

Alternative: one page of runs with `page` and `perPage`. That needs a count read, and the consumer wants only the ids of the runs.

## Risks / Trade-offs

- [A plan with more than 100 runs shows only the newest 100 ids] → `hasMoreRuns` is `true`, and `GET {A}/runs` gives each run with paging.
- [Each fixture of `RunSummary` and `RunDetail` needs the new fields] → The new fields are required, thus the typecheck finds each fixture.
- [A parallel change can edit `src/api/runs.ts` and the `local-server` spec] → The edits stay in the types and the requirements of this change.
