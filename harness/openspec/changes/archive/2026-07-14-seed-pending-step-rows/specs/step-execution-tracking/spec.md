## ADDED Requirements

### Requirement: Step rows are seeded pending at run start

`executeAnalysis` SHALL seed one `cortex_step_executions` row per plan step in a single durable step at run start (after plan validation and `validateAndInit` succeed, before the scheduler loop dispatches anything). Seeded rows SHALL carry `status="pending"`, `started_at=NULL`, `wave` = the step's topological level (the same value the sandbox-step child later writes), `agent_id` from the plan's per-step agent assignment, and the run's `analysis_id`. Seeding SHALL use `ON CONFLICT (run_id, step_id) DO NOTHING` so a replayed or recovered parent never regresses a row a prior execution already advanced — the seed is idempotent and only ever adds missing rows. From the first successful seed, `queryStepsByRun` therefore returns the run's full DAG, so ledger consumers can render honest `done/total` progress including not-yet-started steps.

#### Scenario: A fresh run exposes all steps immediately

- **GIVEN** a 3-step plan whose first step has just started executing
- **WHEN** `queryStepsByRun` is called
- **THEN** 3 rows are returned: one `running` and two `pending` with `started_at` NULL

#### Scenario: Seed replay does not regress advanced rows

- **GIVEN** a recovered parent workflow whose step A is already `completed`
- **WHEN** the seed step replays
- **THEN** step A's row is untouched and only steps with no row are inserted as `pending`

#### Scenario: A step starting flips its seeded row

- **WHEN** the sandbox-step child's mark-running insert runs against a seeded `pending` row
- **THEN** the existing `ON CONFLICT DO UPDATE` flips it to `status="running"` with `started_at` stamped

## MODIFIED Requirements

### Requirement: Step execution query helpers

`src/state/step-executions.ts` SHALL export, each taking a `Querier` first and
returning `ResultAsync<…, DbError>`:

- `seedStepExecutions(pool, rows)`: inserts many rows in one statement with `status="pending"` and `started_at=NULL`, using `ON CONFLICT (run_id, step_id) DO NOTHING` (see the run-start seeding requirement). Each row carries `{ runId, stepId, analysisId, wave, agentId }`.
- `sweepPendingStepExecutions(pool, runId)`: flips the run's still-`pending` rows to `skipped` and stamps `completed_at` — the finalisation sweep `collectAndComplete` runs on genuinely-terminal paths only (see the workflow-failure-lifecycle capability).
- `insertStepExecution(pool, { runId, stepId, analysisId, wave, agentId, childWorkflowId? })`: inserts with `status="running"` and `started_at` using `ON CONFLICT (run_id, step_id) DO UPDATE`.
- `updateStepExecution(pool, runId, stepId, { status, durationMs?, error?, attempts?, lastErrorClass?, blockedReason?, finishReason?, hitMaxSteps? })`: builds the SET clause dynamically so retries bump telemetry without clobbering timing; stamps `completed_at` only for non-`running` statuses; binds `hit_max_steps` as an integer; writes `blocked_reason` when `blockedReason` is supplied.
- `queryStepsByRun(pool, runId)`: returns all rows for a run ordered by `wave`, then `started_at` with an explicit `NULLS LAST` (unstarted steps trail started ones within a wave), then `step_id` as a deterministic tiebreaker for the all-NULL pending group.

There SHALL be NO `queryStepByChildWorkflowId` helper — the `(child_workflow_id)`
index exists for future lookups but no query-by-child-workflow-id helper is
shipped.

#### Scenario: Query steps for a run

- **WHEN** `queryStepsByRun(pool, "run-1")` is called
- **THEN** all step rows for that run are returned, ordered by `wave`, then `started_at` NULLS LAST, then `step_id`

#### Scenario: Pending rows order deterministically within a wave

- **GIVEN** a wave holding one `running` row and two seeded `pending` rows
- **WHEN** `queryStepsByRun` is called
- **THEN** the `running` row precedes the `pending` rows, and the `pending` rows are ordered by `step_id`

#### Scenario: Upsert on re-execution

- **WHEN** `insertStepExecution` is called for an existing `(run_id, step_id)` (e.g. a resumed child after a 402 pause)
- **THEN** the row is updated with the new `wave`, `agent_id`, `status`, `started_at`, `child_workflow_id`, and `completed_at`/`duration_ms`/`error` reset to NULL

#### Scenario: updateStepExecution writes a blocker reason

- **WHEN** `updateStepExecution(pool, runId, stepId, { status: "blocked", blockedReason: "reference genome not in ref store" })` is called
- **THEN** the row reaches `status="blocked"`, `blocked_reason` carries the reason, and `completed_at` is stamped
