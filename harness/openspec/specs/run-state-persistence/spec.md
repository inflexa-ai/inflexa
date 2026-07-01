## Purpose

Defines the `cortex_runs` table — the thin run ledger — its row schema, its
lifecycle query helpers, and the two invariants that keep run recovery correct.

Two design choices dominate this spec. First, **there is deliberately no
boot-time orphan sweep.** Every `running` row is backed by a live DBOS workflow,
and each host process recovers its own in-flight workflows at launch under a
stable `executorId` (the workflow-recovery decision; see the harness-durable-runtime
spec). A bulk `UPDATE … SET status='failed' WHERE status='running'` on startup
would race that recovery and wrongly fail healthy runs owned by sibling replicas,
so `initCortexState` runs DDL only and leaves run-status transitions to the
workflow bodies. Second, **a run is not all-or-nothing**: the status enum carries
`partial` alongside the terminal trio, and `promoteFailedToPartial` lets a
recovery path rescue a run that produced real artifacts before it died.

The row is a ledger, not the source of truth for rich data — summaries, findings,
and streamed parts live in files, the vector index, and the DBOS-backed stream.
The vestigial `parts` JSONB column is retained read-tolerantly but is no longer
written by the workflow.

## Requirements

### Requirement: cortex_runs table schema

The system SHALL maintain a `cortex_runs` table with: `run_id` (TEXT, PRIMARY
KEY — equal to the DBOS workflowID, a bare UUID), `analysis_id` (TEXT, NOT NULL),
`thread_id` (TEXT, nullable), `workflow_name` (TEXT, NOT NULL), `status` (TEXT,
NOT NULL), `started_at` (TEXT, NOT NULL), `completed_at` (TEXT, nullable),
`error` (TEXT, nullable), `parts` (JSONB, nullable — vestigial), `mandate_jti`
(TEXT, nullable), `mandate_expires_at` (TEXT, nullable), `plan_id` (TEXT,
nullable — dedup key, FK to `cortex_plans`), and `attempt_count` (INTEGER, NOT
NULL DEFAULT 0 — parent-workflow resume counter).

Indexes SHALL exist on `(analysis_id)` and `(thread_id)`. A partial-unique index
`idx_cortex_runs_active_plan` SHALL exist on `(analysis_id, plan_id) WHERE status
IN ('running','suspended_insufficient_funds')`. The table SHALL NOT have a
`workflow_id` column (`run_id` IS the workflowID), SHALL NOT have a
`mandate_token` column, and SHALL have NO `plan`, `plan_version`, `current_wave`,
or `suspension` columns — those are dropped on startup via `DROP COLUMN IF
EXISTS`.

#### Scenario: Run created at workflow launch time

- **WHEN** `executePlan` runs the INSERT after the dedup pre-check passes
- **THEN** a row is inserted with the bare-UUID `run_id`, `analysis_id`, `thread_id`, `plan_id`, `workflow_name = "executeAnalysis"`, `status = "running"`, and `started_at`
- **AND** `parts`, `completed_at`, `error` are NULL and `attempt_count` is `0`
- **AND** no `workflow_id` column write is attempted

#### Scenario: Vestigial and dropped columns removed on startup

- **WHEN** the state module initialises
- **THEN** `workflow_id`, `mandate_token`, `plan`, `plan_version`, `current_wave`, and `suspension` SHALL be dropped from `cortex_runs` if present, idempotently

### Requirement: CortexRunRow schema

The `CortexRunRow` Zod schema SHALL define: `runId`, `analysisId`, `threadId`
(nullable), `workflowName`, `status` (enum: `"running"`, `"completed"`,
`"partial"`, `"failed"`, `"canceled"`, `"suspended_insufficient_funds"`),
`startedAt`, `completedAt` (nullable), `error` (nullable), `parts` (array of any,
nullable), `mandateJti` (nullable), `mandateExpiresAt` (nullable), `planId`
(nullable), and `attemptCount` (non-negative integer, default 0). The schema
SHALL NOT contain a `workflowId` or `mandateToken` field.

#### Scenario: Run status values

- **WHEN** a run status is validated
- **THEN** the valid values are `"running"`, `"completed"`, `"partial"`, `"failed"`, `"canceled"`, and `"suspended_insufficient_funds"`

#### Scenario: workflowId field is absent

- **WHEN** a `CortexRunRow` is parsed
- **THEN** the result has no `workflowId` field, and callers read `row.runId` instead

### Requirement: Run query helpers

The state module SHALL export the following helpers, each taking a
`pg.Pool`/`PoolClient` (`Querier`) first and returning `ResultAsync<…, DbError>`
(absence rides the ok channel as `null`/`[]`):

- `insertRun(pool, { runId, analysisId, threadId?, workflowName, planId?, mandateJti?, mandateExpiresAt? })`: inserts with `status='running'` and `started_at`. On the `idx_cortex_runs_active_plan` collision it SHALL throw `RunDedupCollisionError` verbatim ABOVE the Result boundary (a control-flow signal, not a `DbError`); the caller recovers via `queryActiveRun`. The input SHALL NOT accept `workflowId`.
- `updateRunStatus(pool, runId, status, error?)`: updates status; sets `completed_at` for the terminal statuses `completed`/`partial`/`failed`/`canceled`.
- `promoteFailedToPartial(pool, runId)`: atomically flips `status` from `'failed'` to `'partial'` and returns whether a row changed.
- `bumpRunAttemptCount(pool, runId)`: atomically increments and returns `attempt_count`; a missing row is an invariant violation surfaced on the err channel.
- `setRunMandate(pool, runId, jti, expiresAt)`: writes the run-mandate audit columns (no `token` parameter — the column does not exist).
- `queryRun(pool, runId)`: returns one `CortexRunRow` or null.
- `queryActiveRun(pool, analysisId, planId)`: returns the single `running`/`suspended_insufficient_funds` row for `(analysisId, planId)` or null.
- `queryRunsByAnalysis(pool, analysisId, { limit?, offset? })`: returns runs for an analysis ordered by `started_at DESC`.
- `queryRunsByThread(pool, analysisId, threadId, { limit?, offset? })`: returns runs for a thread (scoped to the analysis) ordered by `started_at DESC`.

There SHALL be NO `updateRunParts`, `failOrphanedRuns`, `failOrphanedSteps`, or
`queryGlobalSyncStatus` helper.

#### Scenario: Insert and query a run

- **WHEN** `insertRun(pool, { runId: "uuid-1", analysisId: "a-1", threadId: "t-1", planId: "p-1", workflowName: "executeAnalysis" })` then `queryRun(pool, "uuid-1")` are called
- **THEN** the result includes `runId: "uuid-1"`, `status: "running"`, `parts: null`, `attemptCount: 0`, and no `workflowId` field

#### Scenario: queryActiveRun recovers from a dedup collision

- **GIVEN** an active row for `("a-1","p-1")` with `run_id = "uuid-existing"`
- **WHEN** a second `insertRun` for `("a-1","p-1")` throws `RunDedupCollisionError`
- **AND** the caller calls `queryActiveRun(pool, "a-1", "p-1")`
- **THEN** the row with `run_id = "uuid-existing"` is returned

#### Scenario: promoteFailedToPartial rescues a failed run

- **GIVEN** a `cortex_runs` row with `status = 'failed'`
- **WHEN** `promoteFailedToPartial(pool, runId)` is called
- **THEN** the row's `status` becomes `'partial'` and the function returns `true`
- **AND** a second call returns `false` (no longer `failed`)

#### Scenario: bumpRunAttemptCount increments the resume counter

- **WHEN** `bumpRunAttemptCount(pool, runId)` is called on a row with `attempt_count = 0`
- **THEN** the function returns `1` and the row's `attempt_count` is `1`

### Requirement: There is no boot-time orphan sweep

`initCortexState()` SHALL NOT bulk-transition `running` runs or steps to
`failed` on startup. It SHALL run DDL (idempotent `CREATE TABLE`/`ALTER TABLE …
IF [NOT] EXISTS`) under the `cortex_state_init` advisory lock and nothing more
to run state. Recovery of in-flight runs is owned by DBOS workflow recovery under
each host's stable `executorId`; the workflow body owns the terminal transition.
A boot-time bulk fail would race that recovery and wrongly mark sibling-replica
runs as failed.

#### Scenario: Restart leaves running rows untouched

- **GIVEN** `cortex_runs` has rows with `status = 'running'` from a previous process
- **WHEN** `initCortexState()` executes on boot
- **THEN** those rows remain `'running'` (no bulk UPDATE is issued)
- **AND** DBOS recovery reclaims their workflows under the stable `executorId`

#### Scenario: Init touches only schema

- **WHEN** `initCortexState()` runs
- **THEN** it executes DDL and additive migrations under the advisory lock and issues no `UPDATE … WHERE status='running'` against `cortex_runs` or `cortex_step_executions`

### Requirement: Partial-unique index enforces one active run per (analysis_id, plan_id)

The `idx_cortex_runs_active_plan` partial-unique index SHALL be created on startup
via `CREATE UNIQUE INDEX IF NOT EXISTS` on `(analysis_id, plan_id) WHERE status IN
('running','suspended_insufficient_funds')`. A second active insert for the same
pair SHALL raise a unique violation; the caller SHALL catch it (as
`RunDedupCollisionError`) and resolve to the existing active `run_id` via
`queryActiveRun`. Terminal rows (`completed`/`partial`/`failed`/`canceled`) are
excluded from the predicate so a deliberate re-run after completion succeeds.

#### Scenario: Concurrent double-trigger collides on the index

- **GIVEN** an active run exists for `(analysis_id, plan_id) = ("a1","p1")`
- **WHEN** a second concurrent insert for the same pair is attempted
- **THEN** the insert raises a unique violation and the caller resolves it to the existing `run_id`

#### Scenario: Terminal rows do not block re-runs

- **GIVEN** a prior run for `("a1","p1")` reached `status = 'completed'` (or `partial`, `failed`, `canceled`)
- **WHEN** a fresh insert for `("a1","p1")` runs
- **THEN** the insert succeeds because the partial predicate excludes terminal rows

### Requirement: cortex_runs.parts is no longer written by the workflow

The `parts` JSONB column SHALL remain on `cortex_runs` and SHALL be read
tolerantly (`mapRunRow` returns a native array, a parsed legacy TEXT value, or
`null`), but the DBOS workflow SHALL NOT write it — the DBOS-backed run-event
stream is the persistence surface for parts. There SHALL be no `updateRunParts`
helper.

#### Scenario: New workflow never writes parts

- **WHEN** the `executeAnalysis` parent or child workflows run
- **THEN** `cortex_runs.parts` remains NULL for runs they originate

#### Scenario: NULL parts read back as null

- **WHEN** `queryRun(pool, runId)` is called for a run with `parts IS NULL`
- **THEN** the returned `parts` field is `null`

### Requirement: file_type column on cortex_artifacts

The `cortex_artifacts.file_type` (TEXT, nullable) column SHALL be added on
startup and populated by `registerStepArtifacts` from each
`ArtifactManifestEntry.type` (mapped at the bind site as `fileType: a.type`). On
upsert conflict the column SHALL be preserved via `COALESCE(EXCLUDED.file_type,
cortex_artifacts.file_type)`, and `updateArtifactId` MAY backfill it. The column
feeds the `data-step-output` stream part's per-file `fileType`; it is not consumed
by any parts-reconstruction routine (none exists).

#### Scenario: file_type populated during registration

- **GIVEN** a step produces an artifact with manifest type `"figure"`
- **WHEN** `registerStepArtifacts` inserts it into `cortex_artifacts`
- **THEN** `file_type` is `"figure"`

#### Scenario: file_type preserved on upsert conflict

- **GIVEN** an artifact row with `file_type = "script"` already exists
- **WHEN** the same path is upserted with `fileType: null`
- **THEN** `file_type` remains `"script"` (COALESCE preserves the existing value)
