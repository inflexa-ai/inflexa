# Design

## Context

- `loadPlan` (`src/state/plans.ts:135-144`) gives only the `plan` JSONB. Seven call sites use it. Thus a change of its return breaks callers that want no lineage.
- `cortex_plans` has one index, `idx_cortex_plans_analysis(analysis_id, created_at DESC)` (`src/state/migrations/20260927120000_baseline.ts:133-134`). `parent_plan_id` is a self key with `ON DELETE SET NULL`, and no index covers it.
- `cortex_runs.plan_id` (`baseline.ts:514`) has only the partial unique index `idx_cortex_runs_active_plan ... WHERE status = 'running'` (`src/state/migrations/20261013180000_narrow_the_active_run_index.ts:14`). A read of all the runs of a plan walks `idx_cortex_runs_analysis_started` and filters each run of the analysis.
- `computeTopologicalLevels` (`src/workflows/execute-analysis-scheduler.ts:230-253`) gives the levels of `data-dag-state`. It throws on a missing dependency, and it requires `validatePlanDag` (`:85-105`) first.
- The stored plan schema `AnalysisPlanSchema` (`src/schemas/workflow-state.ts:73-87`) keeps `agent` optional. The run stream uses `"unknown"` for a step with no agent (`src/workflows/execute-analysis.ts:1180`, `src/tools/execute-analysis.ts:235`).
- `buildPlanCardData` (`src/memory/card-builders.ts:69-89`) builds the `data-plan` payload from `loadPlan`. `PlanPartSchema` (`src/contracts/schemas/chat-parts.ts:73-82`) is not strict, thus it drops a key that it does not name.

## Goals / Non-Goals

**Goals:**

- One read that gives a plan, its parent, and its newest child, in one statement. Issue #650 uses the same read for its refusal of a replaced plan.
- A bounded read of the run ids of a plan.
- One level algorithm for the run stream and for the plan graph read.

**Non-Goals:**

- No change of `loadPlan` and its callers.
- No change of the plan writes (`insertPlan`, `upsertPlan`).
- No cli route. The companion cli change connects the reads.

## Decisions

### D1. A new lineage read, not a wider `loadPlan`

Add `loadPlanRecord(pool, planId, { analysisId })` to `src/state/plans.ts`. It gives `ResultAsync<PlanRecord | null, DbError>`. `PlanRecord` is `{ planId, plan: unknown, parentPlanId: string | null, supersededBy: string | null, createdAt: string }`. One statement reads the row, and a scalar subquery reads the newest child:

```sql
SELECT p.plan, p.parent_plan_id, p.created_at,
       (SELECT c.plan_id FROM cortex_plans c
         WHERE c.parent_plan_id = p.plan_id AND c.analysis_id = p.analysis_id
         ORDER BY c.created_at DESC, c.plan_id DESC LIMIT 1) AS superseded_by
  FROM cortex_plans p
 WHERE p.plan_id = $1 AND p.analysis_id = $2
```

Alternative: change `loadPlan` to give the row. That touches seven callers for a field that they do not read. Alternative: a separate read of the child. That costs a second round trip for each plan read.

`supersededBy` is the newest child, because a person can revise one plan two times. The issue asks for "the id of the newer plan". `created_at` is an ISO 8601 text, thus a text order is a time order. The plan id breaks a tie, thus the answer is stable.

### D2. The run ids of a plan

Add `queryRunIdsByPlan(pool, { analysisId, planId, limit })` to `src/state/runs.ts`. It gives `ResultAsync<string[], DbError>`:

```sql
SELECT run_id FROM cortex_runs
 WHERE analysis_id = $1 AND plan_id = $2
 ORDER BY started_at DESC, run_id DESC
 LIMIT $3
```

The caller gives the limit. Thus the size of the answer does not grow with the run history of a plan.

### D3. One migration with two indexes

Add `src/state/migrations/20261014120000_index_the_plans_by_parent_and_the_runs_by_plan.ts`, and register it in `src/state/migrations/index.ts`:

- `CREATE INDEX IF NOT EXISTS idx_cortex_plans_parent ON cortex_plans(parent_plan_id)`
- `CREATE INDEX IF NOT EXISTS idx_cortex_runs_plan ON cortex_runs(analysis_id, plan_id, started_at DESC, run_id DESC)`

The first index serves the subquery of D1. It also serves the `ON DELETE SET NULL` check of the self key, which the purge of an analysis runs for each deleted plan. The second index serves D2 and the latest-run read of `buildRunCardData` (`src/memory/card-builders.ts:120-128`). Without it, each read walks each run of the analysis.

Alternative: no runs index, and a scan of the runs of the analysis. The cost then grows with the run history of the analysis, which the code does not control.

### D4. The plan graph reuses the scheduler levels

Add `planGraphOf(plan: unknown): PlanGraphStep[] | null` to a new `src/workflows/plan/graph.ts`. The function does these steps:

1. Parse the document with `AnalysisPlanSchema`. On a failure, give `null`. A plan with an empty step list gives an empty graph, because the schema accepts it and the plan has no step to draw.
2. Run `validatePlanDag` on `{ id, depends_on }` of each step. It throws a typed error on a duplicate id, a missing dependency, or a cycle. The function catches the throw at this boundary and gives `null`.
3. Run `computeTopologicalLevels`, and map each step to `{ id, name, agent: step.agent ?? "unknown", dependsOn: [...step.depends_on], level }` in the order of the plan.

`PlanGraphStep` is `Pick<DagStepState, "id" | "name" | "agent" | "dependsOn" | "level">`, in `src/contracts/chat-parts.ts`. Thus the graph read and the run stream share one shape and one algorithm.

Alternative: a cycle-safe Kahn traversal, as in the cli `plan_dag.ts:147-175`. That is a second level algorithm, and it gives a level for an invalid plan that no run can execute.

### D5. The card carries the parent

- `PlanPart` gets `parentPlanId?: string`. `PlanPartSchema` gets `parentPlanId: z.string().regex(/^pln-[a-f0-9]{8}$/).optional()`.
- `PlanCardData` gets `parentPlanId?: string`.
- A pure `planCardOf(record: PlanRecord, title?: string): PlanCardData | null` holds the body of `buildPlanCardData`, and it adds `parentPlanId` when the record has one. `buildPlanCardData` becomes `loadPlanRecord(...).map((record) => record && planCardOf(record, title))`. Thus `show_plan` reads the parent in the same statement as the plan.
- A pure `planPartOf(record: PlanRecord): PlanPart | null` gives `PlanPartSchema.safeParse({ type: "data-plan", ...planCardOf(record) })`, or `null`. It gives no title argument, thus the part has the title of the plan and not a `show_plan` override. The cli plan route uses it. The part schema drops each key that it does not name. Thus the route gives the same card as the stored card of a transcript.

### D6. Exports

`src/state/index.ts` exports `loadPlanRecord`, `PlanRecord`, and `queryRunIdsByPlan`. `src/contracts/index.ts` exports the type `PlanGraphStep`, thus a cli wire type imports it with no harness code. The root barrel `src/index.ts` exports `loadPlanRecord`, `PlanRecord`, `queryRunIdsByPlan`, `planGraphOf`, `PlanGraphStep`, and `planPartOf`. A barrel test, in the pattern of `src/state/artifact-reads.barrel.test.ts`, imports each name from the root.

## Risks / Trade-offs

- [A child plan of a different analysis counts as the successor] → `checkParentScope` (`src/state/plans.ts:38-52`) refuses such a parent. The subquery also filters the analysis.
- [The index build locks the two tables for writes] → The tables are small on a local machine. Each migration has a lock timeout of 5 s.
- [A lock timeout fails the start] → The next start applies the migration again.
- [A plan that fails the part schema gives no part] → An example is a step with no agent. The transcript also shows no card for that plan, thus the route and the chat agree.

## Migration Plan

The migration runs at the next `initCortexState`. It only adds indexes. A rollback needs no step, because an index that the code does not read does no harm.
