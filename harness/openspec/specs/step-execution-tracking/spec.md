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

The row is a ledger. The rich data (the summaries and the file descriptions) is
in files and in the vector index, not in columns. `sandbox_ref` is the one item
of live operational state. It holds the handle of the machine of a running step.
The reaper finds the row of a machine that it removed by this handle, and it
clears the handle. The row holds no exec id.

## Requirements

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

### Requirement: The run's synthesis phase has a reserved ledger row

`cortex_step_executions` SHALL carry at most one reserved **run-phase** row per
run for run-level synthesis, identified by `step_id = "synthesis"` and
`agent_id = "run-synthesizer"`, with `wave` strictly greater than every DAG
step's topological level so ledger-ordered readers (`queryStepsByRun`'s
`ORDER BY wave, started_at NULLS LAST, step_id`) render it after every DAG
step. The row SHALL use only the existing columns and status vocabulary — no
schema change distinguishes a run-phase row from a DAG-step row; the reserved
identity is the distinction.

The parent workflow SHALL resolve synthesis enablement from
`ExecuteAnalysisInput.synthesisEnabled`, defaulting an absent value to `true`
for workflows persisted before the field existed. It SHALL seed the row as
`pending` in the same seed operation that seeds the DAG rows ONLY when synthesis
is enabled for that run. A run whose input disables synthesis reports no
synthesis row at all, so its step count stays the plan's step count. From the
seed onward, `done/total` derived from the ledger is honest — the denominator
includes synthesis from the first frame rather than growing when synthesis
starts.

#### Scenario: Seeded pending with the DAG when synthesis is enabled

- **GIVEN** `executeAnalysis` starts a 5-step plan with `synthesisEnabled: true`
- **WHEN** the step ledger is seeded at run start
- **THEN** `queryStepsByRun` returns 6 rows — the 5 DAG steps plus a `pending` `synthesis` row with `agent_id = "run-synthesizer"` — and the `synthesis` row orders last

#### Scenario: Not seeded when synthesis is disabled

- **GIVEN** `executeAnalysis` starts with `synthesisEnabled: false`
- **WHEN** the step ledger is seeded at run start
- **THEN** no `synthesis` row exists for the run and the ledger's row count equals the plan's step count

#### Scenario: Legacy input preserves synthesis

- **GIVEN** a recovered `executeAnalysis` input persisted before `synthesisEnabled` existed
- **WHEN** the parent resolves synthesis behavior
- **THEN** it treats synthesis as enabled

#### Scenario: Replayed seed cannot reset an advanced synthesis row

- **GIVEN** a recovery replay re-executes the seed against a `synthesis` row a prior execution already advanced past `pending`
- **WHEN** the seed runs
- **THEN** the row's status is unchanged (the seed is conflict-do-nothing, idempotent and monotone)

### Requirement: The synthesis row transitions with the phase it describes

The parent workflow SHALL mark the `synthesis` row `running` (stamping
`started_at`) immediately before the `synthesize-findings` step executes, and
SHALL stamp its terminal status (with `completed_at` and `duration_ms`)
immediately after that step settles — on the success path and on the failure
path — **before** the run row's own terminal status is written, so no reader
observes a terminal run beside a still-`running` synthesis row. The
mark-running transition SHALL occur only when the run's synthesis gate passes
(synthesis enabled AND at least one completed step); a seeded row whose gate
never passes stays `pending` and is finalized by the existing terminal sweep
(`pending` → `skipped`), like any never-dispatched DAG step.

Failures writing the mark-running or terminal transition SHALL log and continue
(the finalisation discipline of the run's other terminal ledger writes): a
progress row must never fail an otherwise-healthy run.

Workflow cancellation SHALL NOT be classified as a synthesis outcome: a
`DBOSWorkflowCancelledError` raised while synthesis is in flight re-propagates
unchanged (the sandbox-step rule), leaving the row untouched — on that path the
run row itself never reaches a terminal status either, so the pair stays
consistent, and the CANCELLED-workflow-over-`running`-ledger shape is the
pre-existing wedge class `inflexa run` already detects.

#### Scenario: Cancellation mid-synthesis is not a synthesis failure

- **GIVEN** the workflow is cancelled while `synthesize-findings` is in flight
- **WHEN** the cancellation error reaches the synthesis error handling
- **THEN** it re-propagates unchanged — the `synthesis` row is not stamped
  `failed`, no synthesis outcome is recorded on `cortex_runs`, and both rows
  still read `running` under the CANCELLED workflow

#### Scenario: Running while synthesis works

- **GIVEN** a run whose last DAG step just completed and whose synthesis gate
  passes
- **WHEN** `synthesize-findings` is executing
- **THEN** `queryStepsByRun` reports the `synthesis` row `running` with
  `started_at` set, while the run row is still `running`

#### Scenario: Terminal before the run row

- **WHEN** synthesis settles (any outcome)
- **THEN** the `synthesis` row reaches its terminal status before
  `cortex_runs.status` leaves `running`

#### Scenario: Gate never passes — swept to skipped

- **GIVEN** synthesis is enabled but the run completes zero steps
- **WHEN** the run finalizes
- **THEN** the `synthesis` row is `skipped` (via the terminal sweep), never
  `running`

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
