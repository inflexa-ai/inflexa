## MODIFIED Requirements

### Requirement: cortex_step_executions table schema

The system MUST maintain a `cortex_step_executions` table with these columns:

- `run_id` (TEXT, NOT NULL), `step_id` (TEXT, NOT NULL), and `analysis_id` (TEXT, NOT NULL)
- `wave` (INTEGER, NOT NULL), the topological level for the UI layout, not a scheduling barrier
- `agent_id` (TEXT, NOT NULL) and `status` (TEXT, NOT NULL)
- `started_at` (TEXT, nullable), `completed_at` (TEXT, nullable), and `duration_ms` (BIGINT, nullable)
- `error` (TEXT, nullable), `attempts` (INTEGER NOT NULL DEFAULT 1), and `last_error_class` (TEXT, nullable)
- `finish_reason` (TEXT, nullable), `hit_max_steps` (INTEGER NOT NULL DEFAULT 0), and `blocked_reason` (TEXT, nullable)
- `child_workflow_id` (TEXT, nullable)

Primary key MUST be `(run_id, step_id)`. The table MUST have no `exec_id`
column and no `sandbox_ref` column. The lease table of the sandbox module
records the machine of a step (see the sandbox-leases spec).

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

#### Scenario: The sandbox reference column is dropped

- **GIVEN** a database whose `cortex_step_executions` has the `sandbox_ref` column
- **WHEN** the migration `20261030120000_lease_the_sandboxes` runs
- **THEN** the table has no `sandbox_ref` column, and each other column keeps its data

### Requirement: StepExecutionRow schema

The `StepExecutionRow` Zod schema MUST define these fields:

- `runId`, `stepId`, `analysisId`, `wave` (number), and `agentId`
- `status`: one of `"pending"`, `"running"`, `"completed"`, `"failed"`, `"skipped"`, `"canceled"`, and `"blocked"`
- `startedAt`, `completedAt`, `durationMs`, and `error`, each nullable
- `attempts` (number, default 1), `lastErrorClass` (nullable), and `finishReason` (nullable)
- `hitMaxSteps` (boolean, default false) and `blockedReason` (nullable, default null)
- `childWorkflowId` (nullable)

It MUST define no `execId` and no `sandboxRef`.

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

The migration `20261030120000_lease_the_sandboxes` MUST drop the `sandbox_ref`
column with `DROP COLUMN IF EXISTS`.

#### Scenario: First startup adds columns and indexes

- **GIVEN** a fresh Postgres without the new columns
- **WHEN** the state module initialises
- **THEN** the columns of the table schema exist and the `idx_cortex_step_exec_child_workflow` index exists
- **AND** no `exec_id` column, no `sandbox_ref` column, and no `idx_cortex_step_exec_active_sandbox` index exist

#### Scenario: Re-running startup is a no-op

- **GIVEN** a Postgres where the migration already ran
- **WHEN** the state module initialises again
- **THEN** no error is thrown and no schema change occurs

#### Scenario: Pre-existing rows tolerate NULL

- **GIVEN** rows that existed before the migration
- **WHEN** the migration completes
- **THEN** their new columns are NULL/default and reads return them without throwing

## REMOVED Requirements

### Requirement: sandbox_ref tracks the live-sandbox registry

**Reason**: The lease table `cortex_sandbox_leases` records the current machine of each lease. A step row holds no sandbox reference, and the reaper that read the column goes away.

**Migration**: Read the machine of a step from `cortex_sandbox_leases`, by the lease key of the step workflow. The migration `20261030120000_lease_the_sandboxes` drops the column.
