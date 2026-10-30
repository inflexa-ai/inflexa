# Design

## Context

`queryArtifactPage` (`src/state/artifacts.ts`) builds one `WHERE` text. The count statement and the page statement use the same text, thus a new condition filters the entries, `total`, and `extensionCounts` together. `countArtifactsByRuns` counts only `role = 'step_output'`. Each `step_output` row carries its run (`src/execution/artifact-registration.ts`), thus the two counts agree when the page read selects the same role.

`loadPlanRecord` (`src/state/plans.ts`) reads `supersededBy` with a correlated subquery. The index `idx_cortex_plans_parent` serves it. `queryRunIdsByPlan` (`src/state/runs.ts`) orders the runs of a plan by `started_at DESC, run_id DESC`, and `idx_cortex_runs_plan` serves that order. `idx_cortex_plans_analysis (analysis_id, created_at DESC)` serves a read of the plans of one analysis, newest first.

`cortex_plans` has no thread column, and the plan writer gets no thread id (`src/tools/research/generate-plan.ts`).

## Goals / Non-Goals

**Goals:**

- One condition for the role in the paged ledger read.
- One page of the plans of an analysis in two statements, whatever the page size.

**Non-Goals:**

- A filter of the plans by thread. Refer to the decision below.
- A change to `loadPlanRecord` output, to `countArtifactsByRuns`, or to a migration.
- The `data-plan` part in a page entry. A host reads the part of one plan with the lineage read.

## Decisions

### The role filter

`ArtifactPageQuery` gets `role?: ArtifactRole`, and the read adds `role = $n` to the conditions. The read trusts the value, because the host validates it where the input enters. The alternative was a list of roles. One role is enough for each known caller, and the type stays as narrow as the use.

### The page of the plans

The new read is `queryPlanPage(pool, analysisId, { limit, offset })` in `src/state/plans.ts`. It gives `{ entries, total }`. It takes a `Querier`, as `queryArtifactPage` does.

The read sends two statements: a `COUNT(*)` of the plans of the analysis, and the page. A window count in the page statement was the alternative. A page past the end has no row to carry the count, thus `queryArtifactPage` uses the same two statements.

The page statement orders by `created_at DESC, plan_id DESC`. This is the order of "newest" in the `supersededBy` rule, thus the first entry and `supersededBy` agree on which plan is the newest.

### `supersededBy` has one definition

The correlated subquery of `loadPlanRecord` moves into one SQL fragment of `src/state/plans.ts`. `loadPlanRecord` and the page read use the fragment. Thus the two reads cannot disagree on the rule. The fragment refers to the outer row as `p`.

### `newestRunId`

A correlated subquery on `cortex_runs` gives the newest run of each plan: `WHERE analysis_id = p.analysis_id AND plan_id = p.plan_id ORDER BY started_at DESC, run_id DESC LIMIT 1`. This is the order of `queryRunIdsByPlan` and `queryNewestPlanRun`. The subquery runs once for each row of the page, and `idx_cortex_runs_plan` serves it. The statement count does not change with the page size.

### The title

The statement reads `CASE WHEN jsonb_typeof(p.plan->'title') = 'string' THEN p.plan->>'title' END`. The read does not give the full document. A document can be large, and a page holds up to 200 plans. The read gives the string as the document holds it. The host applies its own rule of presentation, for example the trim.

### No filter by thread

The page reads all plans of the analysis. The plan row has no thread id, the writer of a plan gets none, and `supersededBy` is a rule of the analysis. Issue #737 and its consumer ask for the latest plan of an analysis. A thread filter needs a new column, a migration, and a change to the plan writer, and plans that exist have no thread. This change does not add it.

## Risks / Trade-offs

- [A `step_output` row with no `source_run` counts in the role total, but in no run count. The type and the table permit such a row.] → `registerStepArtifacts` is the one writer of `step_output` rows, and it writes the run of each row. The data profile writes `input` rows only. Thus no writer makes such a row, and this change adds no rule for it.
- [The title of a page entry can have spaces at the start and the end.] → The read gives the stored string. The host trims it, as the run summary does.
