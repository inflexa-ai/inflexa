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

- **WHEN** a caller runs `insertStepExecution` for a `(run_id, step_id)` that already has a row (for example, a child that resumes after a suspension)
- **THEN** the row is updated with the new `wave`, `agent_id`, `status`, `started_at`, `child_workflow_id`, and `completed_at`/`duration_ms`/`error` reset to NULL

#### Scenario: updateStepExecution writes a blocker reason

- **WHEN** `updateStepExecution(pool, runId, stepId, { status: "blocked", blockedReason: "reference genome not in ref store" })` is called
- **THEN** the row reaches `status="blocked"`, `blocked_reason` carries the reason, and `completed_at` is stamped

### Requirement: sandbox_ref and exec_id track the live-sandbox registry

`cortex_step_executions` SHALL maintain `sandbox_ref` (JSONB) and `exec_id`
(TEXT) for the liveness watchdog. `sandbox_ref` carries the serialised handle
`{ sandboxId, host, port, backend }` — `callbackSecret` is NEVER persisted (it
lives only in the DBOS step-output cache). `exec_id` carries the in-flight
`"${workflowId}:${stepId}:${functionId}"`. Both SHALL be NULL when no sandbox is
live. The partial index `idx_cortex_step_exec_active_sandbox` SHALL support the
watchdog enumerating active sandboxes via `status='running' AND sandbox_ref IS NOT
NULL`.

The sandbox client MUST write `sandbox_ref` and `exec_id` in `createSandbox(session, spec, identity)`. The client MUST
select the row from the session. The run id is `session.runFrame.runId`, and the step id is
`session.runFrame.stepId`. The spec holds no run id and no step id.

#### Scenario: createSandbox populates the registry row

- **WHEN** the sandbox-step child runs `createSandbox(session, spec, identity)` in its durable step, with its step session
- **THEN** the client writes `sandbox_ref` and `exec_id` on the row of `session.runFrame.runId` and `session.runFrame.stepId`
- **AND** the `status` of that row is `"running"`

#### Scenario: teardown clears the registry row

- **WHEN** the child's `teardown` durableStep runs (on success, fail, or cancel)
- **THEN** `sandbox_ref` and `exec_id` are set to NULL

#### Scenario: callbackSecret never persists

- **WHEN** `sandbox_ref` is serialised to the database
- **THEN** the JSONB does not contain a `callbackSecret` field

#### Scenario: Watchdog query is index-supported

- **WHEN** the watchdog enumerates active sandboxes via `WHERE status='running' AND sandbox_ref IS NOT NULL`
- **THEN** the query uses the `idx_cortex_step_exec_active_sandbox` partial index
