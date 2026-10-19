## MODIFIED Requirements

### Requirement: Step execution query helpers

`src/state/step-executions.ts` SHALL export, each taking a `Querier` first and
returning `ResultAsync<…, DbError>`:

- `seedStepExecutions(pool, rows)`: inserts many rows in one statement with `status="pending"` and `started_at=NULL`, using `ON CONFLICT (run_id, step_id) DO NOTHING` (see the run-start seeding requirement). Each row carries `{ runId, stepId, analysisId, wave, agentId }`.
- `sweepPendingStepExecutions(pool, runId)`: flips the run's still-`pending` rows to `skipped` and stamps `completed_at` — the finalisation sweep `collectAndComplete` runs on genuinely-terminal paths only (see the workflow-failure-lifecycle capability).
- `cancelRunningStepExecutions(pool, runId, reason)`: changes the still-`running` rows of the run to `canceled` in one conditional statement. It writes `completed_at`, a `duration_ms` from `started_at` (NULL when `started_at` is NULL), and `reason` in `error`. It does not change a row with a different status. The run canceler calls it after an engine cancel (see the run-cancellation capability).
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

- **WHEN** a caller runs `insertStepExecution` for a `(run_id, step_id)` that already has a row (for example, a child that resumes after a suspension)
- **THEN** the row is updated with the new `wave`, `agent_id`, `status`, `started_at`, `child_workflow_id`, and `completed_at`/`duration_ms`/`error` reset to NULL

#### Scenario: updateStepExecution writes a blocker reason

- **WHEN** `updateStepExecution(pool, runId, stepId, { status: "blocked", blockedReason: "reference genome not in ref store" })` is called
- **THEN** the row reaches `status="blocked"`, `blocked_reason` carries the reason, and `completed_at` is stamped

#### Scenario: The running settle touches only running rows

- **GIVEN** a run with one `running` row, one `pending` row, and one `completed` row
- **WHEN** `cancelRunningStepExecutions(pool, runId, "external_cancel")` is called
- **THEN** only the `running` row becomes `canceled`, with `completed_at`, `duration_ms`, and `error` = `"external_cancel"`
- **AND** the `pending` row and the `completed` row do not change
