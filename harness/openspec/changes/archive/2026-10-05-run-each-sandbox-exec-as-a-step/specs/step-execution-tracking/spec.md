## ADDED Requirements

### Requirement: sandbox_ref tracks the live-sandbox registry

`cortex_step_executions` MUST keep `sandbox_ref` (JSONB) as the live-sandbox
registry of the step. `sandbox_ref` carries the serialized handle
`{ sandboxId, host, port, backend }`. It MUST be NULL when no sandbox is live.

The sandbox client MUST write `sandbox_ref` in `createSandbox(session, spec, identity)`. The client MUST
select the row from the session. The run id is `session.runFrame.runId`, and the step id is
`session.runFrame.stepId`. The spec holds no run id and no step id. The `teardown` MUST clear
`sandbox_ref`, and the reaper MUST clear it when it reconciles the row of a machine that it removed.

#### Scenario: createSandbox populates the registry row

- **WHEN** the sandbox-step child runs `createSandbox(session, spec, identity)` in its durable step, with its step session
- **THEN** the client writes `sandbox_ref` on the row of `session.runFrame.runId` and `session.runFrame.stepId`
- **AND** the `status` of that row is `"running"`

#### Scenario: teardown clears the registry row

- **WHEN** the `teardown` step of the child runs (on success, fail, or cancel)
- **THEN** `sandbox_ref` is set to NULL

#### Scenario: The handle holds no secret

- **WHEN** `sandbox_ref` is serialized to the database
- **THEN** the JSONB holds only `sandboxId`, `host`, `port`, and `backend`

## MODIFIED Requirements

### Requirement: cortex_step_executions table schema

The system MUST maintain a `cortex_step_executions` table with: `run_id` (TEXT,
NOT NULL), `step_id` (TEXT, NOT NULL), `analysis_id` (TEXT, NOT NULL), `wave`
(INTEGER, NOT NULL — topological level for UI layout, not a scheduling barrier),
`agent_id` (TEXT, NOT NULL), `status` (TEXT, NOT NULL), `started_at` (TEXT,
nullable), `completed_at` (TEXT, nullable), `duration_ms` (BIGINT, nullable),
`error` (TEXT, nullable), `attempts` (INTEGER NOT NULL DEFAULT 1),
`last_error_class` (TEXT, nullable), `finish_reason` (TEXT, nullable),
`hit_max_steps` (INTEGER NOT NULL DEFAULT 0), `blocked_reason` (TEXT, nullable),
`sandbox_ref` (JSONB, nullable), and `child_workflow_id` (TEXT, nullable).
Primary key MUST be `(run_id, step_id)`. The table MUST have no `exec_id`
column.

Indexes MUST exist on `(analysis_id)` and `(child_workflow_id)`. There MUST be
no index on `(status) WHERE sandbox_ref IS NOT NULL`, and no composite
`(status, sandbox_ref)` index.

#### Scenario: Step execution starts

- **WHEN** a sandbox-step child workflow body begins
- **THEN** a row is inserted with `status="running"`, `agent_id`, `wave`, `analysis_id`, `child_workflow_id`, and `started_at`
- **AND** if a row already exists for `(run_id, step_id)` it is updated (`ON CONFLICT (run_id, step_id) DO UPDATE`), resetting `completed_at`, `duration_ms`, `error` to NULL and `attempts` to 1

#### Scenario: wave carries topological level only

- **WHEN** a step row is inserted
- **THEN** `wave` carries the step's topological level (used for UI layout), not a scheduling gate — the parent's dependency-gated scheduler decides start order

#### Scenario: Vestigial columns removed on startup

- **WHEN** the state module initialises
- **THEN** the `thread_id`, `execution_id`, `resources`, and `summary` columns are dropped from `cortex_step_executions` if present

#### Scenario: The exec id column and the active-sandbox index are dropped

- **GIVEN** a database whose `cortex_step_executions` has the `exec_id` column and the `idx_cortex_step_exec_active_sandbox` index
- **WHEN** the migration `20261005120000_drop_the_active_exec_tracking` runs
- **THEN** the table has no `exec_id` column and no `idx_cortex_step_exec_active_sandbox` index, and each other column keeps its data

### Requirement: StepExecutionRow schema

The `StepExecutionRow` Zod schema MUST define: `runId`, `stepId`, `analysisId`,
`wave` (number), `agentId`, `status` (enum: `"pending"`, `"running"`,
`"completed"`, `"failed"`, `"skipped"`, `"canceled"`, `"blocked"`), `startedAt`
(nullable), `completedAt` (nullable), `durationMs` (nullable), `error`
(nullable), `attempts` (number, default 1), `lastErrorClass` (nullable),
`finishReason` (nullable), `hitMaxSteps` (boolean, default false),
`blockedReason` (nullable, default null), `sandboxRef` (`PersistedSandboxRef`,
nullable), and `childWorkflowId` (nullable). It MUST define no `execId`.

#### Scenario: StepExecutionRow includes blocked status and reason

- **WHEN** a step row is read after its agent called `report_blocker`
- **THEN** `status` is `"blocked"` and `blockedReason` carries the agent-declared reason

#### Scenario: StepExecutionRow includes canceled status

- **WHEN** a step row is read after the parent's fail-fast cascade tore it down
- **THEN** `status` is `"canceled"`

### Requirement: Migration is forward-only and idempotent on startup

The baseline migration MUST add `attempts`, `last_error_class`, `finish_reason`,
`hit_max_steps`, `blocked_reason`, `sandbox_ref`, and `child_workflow_id` to
`cortex_step_executions` through `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. It
MUST promote `duration_ms` to `BIGINT`, and it MUST make the supporting indexes
through `CREATE INDEX IF NOT EXISTS`. Existing rows MUST get NULL or the
defaults, and the migration MUST be safe to run again. The migration
`20261005120000_drop_the_active_exec_tracking` MUST drop the `exec_id` column with
`DROP COLUMN IF EXISTS`, and the `idx_cortex_step_exec_active_sandbox` index with
`DROP INDEX IF EXISTS`.

#### Scenario: First startup adds columns and indexes

- **GIVEN** a fresh Postgres without the new columns
- **WHEN** the state module initialises
- **THEN** the columns above exist and the `idx_cortex_step_exec_child_workflow` index exists
- **AND** no `exec_id` column and no `idx_cortex_step_exec_active_sandbox` index exist

#### Scenario: Re-running startup is a no-op

- **GIVEN** a Postgres where the migration already ran
- **WHEN** the state module initialises again
- **THEN** no error is thrown and no schema change occurs

#### Scenario: Pre-existing rows tolerate NULL

- **GIVEN** rows that existed before the migration
- **WHEN** the migration completes
- **THEN** their new columns are NULL/default and reads return them without throwing

## REMOVED Requirements

### Requirement: sandbox_ref and exec_id track the live-sandbox registry

**Reason**: The `exec_id` column is dropped, because the exec id is the id of a DBOS step and nothing outside that step reads it. The watchdog that read the registry is removed.

**Migration**: Refer to "sandbox_ref tracks the live-sandbox registry". The migration `20261005120000_drop_the_active_exec_tracking` drops the column.
