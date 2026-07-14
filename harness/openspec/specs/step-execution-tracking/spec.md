## Purpose

Defines the `cortex_step_executions` table — a thin per-step ledger of timing,
status, retry telemetry, and the live-sandbox registry handle — plus its row
schema and the query helpers in `src/state/step-executions.ts` (run-level helpers
live in `src/state/runs.ts`). The table tracks runtime execution state
independently from the plan's design-time step definitions; the frontend joins
the two client-side by `stepId`.

Two status values beyond the ordinary set matter here. `canceled` records a step
the parent's fail-fast / pause cascade tore down. `blocked` records a step whose
agent honestly declared it could not produce its deliverable via the
`report_blocker` tool — the harness never *infers* failure from output counts;
honesty is structural. The blocker decision and its fail-fast semantics are owned
by the harness-sandbox-agents spec; this spec owns only how the resulting status
and its reason are persisted (the `blocked_reason` column).

The row is a ledger: rich data (summaries, file descriptions) lives in files and
the vector index, not in columns. The `sandbox_ref`/`exec_id` pair is the one
piece of live operational state — the liveness watchdog reads it to find sandboxes
that need a synthetic-failure unblock.

## Requirements

### Requirement: cortex_step_executions table schema

The system SHALL maintain a `cortex_step_executions` table with: `run_id` (TEXT,
NOT NULL), `step_id` (TEXT, NOT NULL), `analysis_id` (TEXT, NOT NULL), `wave`
(INTEGER, NOT NULL — topological level for UI layout, not a scheduling barrier),
`agent_id` (TEXT, NOT NULL), `status` (TEXT, NOT NULL), `started_at` (TEXT,
nullable), `completed_at` (TEXT, nullable), `duration_ms` (BIGINT, nullable),
`error` (TEXT, nullable), `attempts` (INTEGER NOT NULL DEFAULT 1),
`last_error_class` (TEXT, nullable), `finish_reason` (TEXT, nullable),
`hit_max_steps` (INTEGER NOT NULL DEFAULT 0), `blocked_reason` (TEXT, nullable),
`sandbox_ref` (JSONB, nullable), `exec_id` (TEXT, nullable), and
`child_workflow_id` (TEXT, nullable). Primary key SHALL be `(run_id, step_id)`.

Indexes SHALL exist on `(analysis_id)`; a partial index
`idx_cortex_step_exec_active_sandbox` on `(status) WHERE sandbox_ref IS NOT NULL`;
and `(child_workflow_id)`. There SHALL be no composite `(status, sandbox_ref)`
index.

#### Scenario: Step execution starts

- **WHEN** a sandbox-step child workflow body begins
- **THEN** a row is inserted with `status="running"`, `agent_id`, `wave`, `analysis_id`, `child_workflow_id`, and `started_at`
- **AND** if a row already exists for `(run_id, step_id)` it is updated (`ON CONFLICT (run_id, step_id) DO UPDATE`), resetting `completed_at`, `duration_ms`, `error` to NULL and `attempts` to 1

#### Scenario: wave carries topological level only

- **WHEN** a step row is inserted
- **THEN** `wave` carries the step's topological level (used for UI layout), not a scheduling gate — the parent's dependency-gated scheduler decides start order

#### Scenario: Vestigial columns removed on startup

- **WHEN** the state module initialises
- **THEN** the `thread_id`, `execution_id`, `resources`, and `summary` columns SHALL be dropped from `cortex_step_executions` if present

### Requirement: StepExecutionRow schema

The `StepExecutionRow` Zod schema SHALL define: `runId`, `stepId`, `analysisId`,
`wave` (number), `agentId`, `status` (enum: `"pending"`, `"running"`,
`"completed"`, `"failed"`, `"skipped"`, `"canceled"`, `"blocked"`), `startedAt`
(nullable), `completedAt` (nullable), `durationMs` (nullable), `error`
(nullable), `attempts` (number, default 1), `lastErrorClass` (nullable),
`finishReason` (nullable), `hitMaxSteps` (boolean, default false),
`blockedReason` (nullable, default null), `sandboxRef` (`PersistedSandboxRef`,
nullable), `execId` (nullable), and `childWorkflowId` (nullable).

#### Scenario: StepExecutionRow includes blocked status and reason

- **WHEN** a step row is read after its agent called `report_blocker`
- **THEN** `status` is `"blocked"` and `blockedReason` carries the agent-declared reason

#### Scenario: StepExecutionRow includes canceled status

- **WHEN** a step row is read after the parent's fail-fast cascade tore it down
- **THEN** `status` is `"canceled"`

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

### Requirement: hit_max_steps is bound as an integer

`updateStepExecution` SHALL bind `hit_max_steps` as the JavaScript integer `0` or
`1`, never as a boolean — the column is `INTEGER NOT NULL DEFAULT 0` and
PostgreSQL refuses the implicit `boolean → integer` cast. When `hitMaxSteps` is
absent from the update payload, `hit_max_steps` SHALL be left out of the SET
clause entirely.

#### Scenario: true coerces to 1

- **WHEN** `updateStepExecution` is called with `hitMaxSteps: true`
- **THEN** the bound parameter is the integer `1` and the UPDATE succeeds
- **AND** a subsequent read via `mapStepExecutionRow` returns `hitMaxSteps: true`

#### Scenario: undefined leaves the column untouched

- **WHEN** `updateStepExecution` is called without `hitMaxSteps`
- **THEN** the SET clause omits `hit_max_steps` and the existing DB value is preserved

### Requirement: sandbox_ref and exec_id track the live-sandbox registry

`cortex_step_executions` SHALL maintain `sandbox_ref` (JSONB) and `exec_id`
(TEXT) for the liveness watchdog. `sandbox_ref` carries the serialised handle
`{ sandboxId, host, port, backend }` — `callbackSecret` is NEVER persisted (it
lives only in the DBOS step-output cache). `exec_id` carries the in-flight
`"${workflowId}:${stepId}:${functionId}"`. Both SHALL be NULL when no sandbox is
live. The partial index `idx_cortex_step_exec_active_sandbox` SHALL support the
watchdog enumerating active sandboxes via `status='running' AND sandbox_ref IS NOT
NULL`.

#### Scenario: createSandbox populates the registry row

- **WHEN** the sandbox-step child's `createSandbox` durableStep runs
- **THEN** the row's `sandbox_ref` and `exec_id` are set and `status` is `"running"`

#### Scenario: teardown clears the registry row

- **WHEN** the child's `teardown` durableStep runs (on success, fail, or cancel)
- **THEN** `sandbox_ref` and `exec_id` are set to NULL

#### Scenario: callbackSecret never persists

- **WHEN** `sandbox_ref` is serialised to the database
- **THEN** the JSONB does not contain a `callbackSecret` field

#### Scenario: Watchdog query is index-supported

- **WHEN** the watchdog enumerates active sandboxes via `WHERE status='running' AND sandbox_ref IS NOT NULL`
- **THEN** the query uses the `idx_cortex_step_exec_active_sandbox` partial index

### Requirement: Migration is forward-only and idempotent on startup

The state module SHALL add `attempts`, `last_error_class`, `finish_reason`,
`hit_max_steps`, `blocked_reason`, `sandbox_ref`, `exec_id`, and
`child_workflow_id` to `cortex_step_executions` on startup via `ALTER TABLE …
ADD COLUMN IF NOT EXISTS`, promote `duration_ms` to `BIGINT`, and create the
supporting indexes via `CREATE INDEX IF NOT EXISTS`. Existing rows SHALL be
backfilled with NULL/defaults; the migration SHALL be safe to run repeatedly.

#### Scenario: First startup adds columns and indexes

- **GIVEN** a fresh Postgres without the new columns
- **WHEN** the state module initialises
- **THEN** the columns above exist and the `idx_cortex_step_exec_active_sandbox` and `idx_cortex_step_exec_child_workflow` indexes exist

#### Scenario: Re-running startup is a no-op

- **GIVEN** a Postgres where the migration already ran
- **WHEN** the state module initialises again
- **THEN** no error is thrown and no schema change occurs

#### Scenario: Pre-existing rows tolerate NULL

- **GIVEN** rows that existed before the migration
- **WHEN** the migration completes
- **THEN** their new columns are NULL/default and reads return them without throwing

### Requirement: Decoupled from plan steps

The table SHALL track runtime execution state independently from the plan's step
definitions. Plan steps define design-time intent (name, question, depends_on,
acceptance criteria); step executions track runtime state (agent, timing,
outcome). The frontend SHALL join them client-side by `stepId`.

#### Scenario: Plan step vs step execution

- **WHEN** run data is served to the frontend
- **THEN** plan steps contain design-time definitions and step executions contain runtime records, joined by the shared `stepId`

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
