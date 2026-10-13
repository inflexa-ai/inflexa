# Proposal

## Why

GitHub issue #649: a host cannot draw the plan graph of a finished run without a replay of the run stream. It cannot tell which plan replaced a plan. Each plan row keeps its parent (`src/state/plans.ts:64-127`), but no read gives it, and no index serves a read by the parent (`src/state/migrations/20260927120000_baseline.ts:119-134`). The `data-plan` part has no parent (`src/contracts/chat-parts.ts:60-69`). The levels of a plan graph exist only in the run stream (`src/workflows/execute-analysis.ts:755,1182`).

The harness is the product core. Thus the reads come first in the harness, and the cli connects them in a companion change with the same name. Issue #650 (approve a plan by id) refuses a plan that a newer plan names as its parent, and it uses the lineage read of this change.

## What Changes

- A read of one stored plan with its lineage: the plan document, its parent, the newest plan that names it as the parent (`supersededBy`), and its creation time. The read is scoped to one analysis, and an absent plan is `null`.
- A read of the run ids of one plan, newest first, under a limit that the caller gives.
- A migration that indexes `cortex_plans(parent_plan_id)` and `cortex_runs(analysis_id, plan_id, started_at DESC, run_id DESC)`. The first index serves `supersededBy`, and the second serves the run ids of a plan.
- A pure function that gives the graph of a stored plan: each step with its id, its name, its agent, its dependencies, and its level. The levels are the levels of `data-dag-state`.
- The `data-plan` part and its schema get the optional field `parentPlanId`. The plan card builder reads the parent of the plan and sets the field.
- A pure function that gives the `data-plan` part of a stored plan record, checked by the part schema. The cli plan route uses it.
- The package root exports the new reads, the two functions, and their types.

## Capabilities

### New Capabilities

- `plan-reads`: the reads of a stored plan. They give the plan with its lineage, the run ids of a plan, the graph of its steps, and its `data-plan` card with the parent.

### Modified Capabilities

None.

## Impact

- Harness code: `src/state/plans.ts`, `src/state/runs.ts`, `src/state/index.ts`, `src/state/migrations/` (one new migration and the registry), `src/memory/card-builders.ts`, `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/contracts/index.ts`, a new `src/workflows/plan/graph.ts`, `src/index.ts`, and their tests.
- Database: one migration with two new indexes. The migration list test pins the new name.
- Embedders: the new field `parentPlanId` is optional, thus each current consumer of `data-plan` keeps its behavior.
