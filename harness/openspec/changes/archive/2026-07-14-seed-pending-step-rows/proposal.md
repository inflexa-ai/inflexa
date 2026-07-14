## Why

`cortex_step_executions` only gains a row when a step's child workflow starts executing (`insertStepExecution` at "mark-running"), so ledger consumers see completed + running steps but never the upcoming ones — a 3-step run mid-first-step reads as `0/1`, which is misleading (the CLI's run-progress surfaces render exactly this today). The `pending` status already exists in `StepExecutionStatus` but is never written; the ledger was shaped for a full-DAG record it never receives.

## What Changes

- `executeAnalysis` seeds one `pending` row per plan step at run start (after plan validation, before the scheduler loop), with `started_at` NULL, `wave` = the step's topological level, and `agent_id` from the plan's assignment — so `queryStepsByRun` returns the whole DAG from the first poll.
- Seeding is conflict-tolerant (`ON CONFLICT (run_id, step_id) DO NOTHING`) so a recovered/resumed run never clobbers rows the previous execution already advanced; the existing `insertStepExecution` upsert flips `pending → running` unchanged when a step actually starts.
- `queryStepsByRun` ordering gains a deterministic tail: `wave`, then `started_at` (NULLs last — Postgres default ASC — so unstarted steps trail started ones within a wave), then `step_id` as tiebreaker for the all-NULL pending group.
- `collectAndComplete` sweeps still-`pending` rows to `skipped` on its genuinely-terminal paths (success, fail-fast, external cancel, synthesis failure), so a dead run never advertises steps that look like they might still start. The resumable 402 budget-pause branch is excluded — it leaves pending rows in place for the resumed workflow.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `step-execution-tracking`: rows for a run now exist from run start (seeded `pending`, `started_at` NULL) rather than from first execution; a new seed helper joins the query-helper surface; `queryStepsByRun` ordering gains the NULLs-last/step-id tail.
- `workflow-failure-lifecycle`: `collectAndComplete` additionally sweeps `pending` step rows to `skipped` on terminal statuses (and explicitly does not on the insufficient-funds suspension).

## Impact

- `src/state/step-executions.ts` — new `seedStepExecutions` helper; `queryStepsByRun` ORDER BY tail.
- `src/workflows/execute-analysis.ts` — one new durable step at run start (seed) and one in `collectAndComplete` (sweep).
- Consumers (CLI sidebar/runs dialog via `queryStepsByRun`) start seeing full step counts with no change on their side — `stepStateOf` already maps `pending`/`skipped` to the queued view.
- No schema migration: the columns and the `pending`/`skipped` enum values already exist.
