## MODIFIED Requirements

### Requirement: cortex_runs table schema

The system SHALL maintain a `cortex_runs` table with: `run_id` (TEXT, PRIMARY
KEY — equal to the DBOS workflowID, a bare UUID), `analysis_id` (TEXT, NOT NULL),
`thread_id` (TEXT, nullable), `workflow_name` (TEXT, NOT NULL), `status` (TEXT,
NOT NULL), `started_at` (TEXT, NOT NULL), `completed_at` (TEXT, nullable),
`error` (TEXT, nullable), `parts` (JSONB, nullable — vestigial), `mandate_jti`
(TEXT, nullable), `mandate_expires_at` (TEXT, nullable), and `plan_id` (TEXT,
nullable — planned-run dedup and internal-plan reference, FK to
`cortex_plans`). There MUST be no `attempt_count` column. It was the resume counter of the parent workflow, for an
`executeAnalysis` entry point that resumes a run after a suspension. That entry point does not exist.

Indexes SHALL exist on `(analysis_id)` and `(thread_id)`. A partial-unique index
`idx_cortex_runs_active_plan` SHALL exist on `(analysis_id, plan_id) WHERE status
= 'running'`. The table SHALL NOT have a
`workflow_id` column (`run_id` IS the workflowID), SHALL NOT have a
`mandate_token` column, and SHALL have NO `plan`, `plan_version`, `current_wave`,
or `suspension` columns — those are dropped on startup via `DROP COLUMN IF
EXISTS`.

#### Scenario: Run created at workflow launch time

- **WHEN** `execute_analysis` reserves the row after mode-specific validation
- **THEN** a row is inserted with the bare-UUID `run_id`, `analysis_id`, `thread_id`, `plan_id`, `workflow_name = "executeAnalysis"`, `status = "running"`, and `started_at`
- **AND** `parts`, `completed_at`, `error` are NULL
- **AND** no `workflow_id` column write is attempted

#### Scenario: Vestigial and dropped columns removed on startup

- **WHEN** the state module initialises
- **THEN** `workflow_id`, `mandate_token`, `plan`, `plan_version`, `current_wave`, and `suspension` SHALL be dropped from `cortex_runs` if present, idempotently

### Requirement: Run query helpers

The state module SHALL export the following helpers, each taking a
`pg.Pool`/`PoolClient` (`Querier`) first and returning `ResultAsync<…, DbError>`
(absence rides the ok channel as `null`/`[]`):

- `insertRun(pool, { runId, analysisId, threadId?, workflowName, planId?, mandateJti?, mandateExpiresAt? })`: inserts with `status='running'` and `started_at`. On the `idx_cortex_runs_active_plan` collision it SHALL throw `RunDedupCollisionError` verbatim ABOVE the Result boundary (a control-flow signal, not a `DbError`); the caller recovers via `queryActiveRun`. The input SHALL NOT accept `workflowId`.
- `updateRunStatus(pool, runId, status, error?)`: updates status; sets `completed_at` for the terminal statuses `completed`/`partial`/`failed`/`canceled`/`suspended_insufficient_funds`.
- `promoteFailedToPartial(pool, runId)`: atomically flips `status` from `'failed'` to `'partial'` and returns whether a row changed.
- `setRunMandate(pool, runId, jti, expiresAt)`: writes the run-mandate audit columns (no `token` parameter — the column does not exist).
- `queryRun(pool, runId)`: returns one `CortexRunRow` or null.
- `queryActiveRun(pool, analysisId, planId)`: returns the single `running` row for `(analysisId, planId)` or null.
- `queryRunsByAnalysis(pool, analysisId, { limit?, offset? })`: returns runs for an analysis ordered by `started_at DESC`.
- `queryRunsByThread(pool, analysisId, threadId, { limit?, offset? })`: returns runs for a thread (scoped to the analysis) ordered by `started_at DESC`.

The active set of each run query is `running` only. `running` is the one
non-terminal run status.

There SHALL be NO `updateRunParts`, `failOrphanedRuns`, `failOrphanedSteps`,
`queryGlobalSyncStatus`, or `bumpRunAttemptCount` helper — the last is removed
with the resume-counter scaffolding.

#### Scenario: Insert and query a run

- **WHEN** `insertRun(pool, { runId: "uuid-1", analysisId: "a-1", threadId: "t-1", planId: "p-1", workflowName: "executeAnalysis" })` then `queryRun(pool, "uuid-1")` are called
- **THEN** the result includes `runId: "uuid-1"`, `status: "running"`, `parts: null`, and no `workflowId` field

#### Scenario: queryActiveRun recovers from a dedup collision

- **GIVEN** an active row for `("a-1","p-1")` with `run_id = "uuid-existing"`
- **WHEN** a second `insertRun` for `("a-1","p-1")` throws `RunDedupCollisionError`
- **AND** the caller calls `queryActiveRun(pool, "a-1", "p-1")`
- **THEN** the row with `run_id = "uuid-existing"` is returned

#### Scenario: A suspended run is not active

- **GIVEN** the only row for `("a-1","p-1")` reads `suspended_insufficient_funds`
- **WHEN** `queryActiveRun(pool, "a-1", "p-1")` is called
- **THEN** the result is `null`

#### Scenario: A suspended status stamps completed_at

- **WHEN** `updateRunStatus(pool, runId, "suspended_insufficient_funds", "budget_exceeded")` is called
- **THEN** the row reads `suspended_insufficient_funds` with `error = "budget_exceeded"` and `completed_at` set

#### Scenario: promoteFailedToPartial rescues a failed run

- **GIVEN** a `cortex_runs` row with `status = 'failed'`
- **WHEN** `promoteFailedToPartial(pool, runId)` is called
- **THEN** the row's `status` becomes `'partial'` and the function returns `true`
- **AND** a second call returns `false` (no longer `failed`)

### Requirement: Partial-unique index enforces one active run per (analysis_id, plan_id)

The `idx_cortex_runs_active_plan` partial-unique index SHALL exist on
`(analysis_id, plan_id) WHERE status = 'running'`. A versioned migration SHALL
drop the index of the baseline, whose predicate also named
`suspended_insufficient_funds`, and SHALL make the index again with the
predicate `status = 'running'`. A second active insert for the same
pair SHALL raise a unique violation; the caller SHALL catch it (as
`RunDedupCollisionError`) and resolve to the existing active `run_id` via
`queryActiveRun`. Terminal rows (`completed`/`partial`/`failed`/`canceled`/`suspended_insufficient_funds`) are
excluded from the predicate so a deliberate re-run after completion succeeds.

#### Scenario: Concurrent double-trigger collides on the index

- **GIVEN** an active run exists for `(analysis_id, plan_id) = ("a1","p1")`
- **WHEN** a second concurrent insert for the same pair is attempted
- **THEN** the insert raises a unique violation and the caller resolves it to the existing `run_id`

#### Scenario: Terminal rows do not block re-runs

- **GIVEN** a prior run for `("a1","p1")` reached `status = 'completed'` (or `partial`, `failed`, `canceled`, `suspended_insufficient_funds`)
- **WHEN** a fresh insert for `("a1","p1")` runs
- **THEN** the insert succeeds because the partial predicate excludes terminal rows

#### Scenario: The migration narrows an existing index

- **GIVEN** a database whose `idx_cortex_runs_active_plan` has the predicate of the baseline
- **WHEN** the pending migrations run
- **THEN** the index predicate is `status = 'running'`, and a run of a plan with a `suspended_insufficient_funds` row can be inserted

### Requirement: file_type column on cortex_artifacts

The `cortex_artifacts.file_type` (TEXT, nullable) column SHALL be added on
startup and populated by `registerStepArtifacts` from each
`ArtifactManifestEntry.type` (mapped at the bind site as `fileType: a.type`). On
upsert conflict the column SHALL be preserved via `COALESCE(EXCLUDED.file_type,
cortex_artifacts.file_type)`, and `updateArtifactId` MAY backfill it. The column
feeds the `fileType` of the report-model artifact snapshot and the order of the
upstream artifacts in a step briefing. The per-file `fileType` of the
`data-step-output` part comes from the step manifest, not from this column. It
is not consumed by any parts-reconstruction routine (none exists).

#### Scenario: file_type populated during registration

- **GIVEN** a step produces an artifact with manifest type `"figure"`
- **WHEN** `registerStepArtifacts` inserts it into `cortex_artifacts`
- **THEN** `file_type` is `"figure"`

#### Scenario: file_type preserved on upsert conflict

- **GIVEN** an artifact row with `file_type = "script"` already exists
- **WHEN** the same path is upserted with `fileType: null`
- **THEN** `file_type` remains `"script"` (COALESCE preserves the existing value)

### Requirement: Conditional cancel transition guards concurrent completion

`markRunCanceledIfActive(pool, runId, reason)` SHALL transition the run row to `canceled` — stamping `completed_at` and recording `reason` in `error` — only when its status is in the active set (`running`), and SHALL report whether a row transitioned. A terminal row, a `suspended_insufficient_funds` row included, SHALL be left untouched.

#### Scenario: Active run transitions

- **WHEN** `markRunCanceledIfActive` runs against a `running` run
- **THEN** the row becomes `canceled` with `completed_at` and `error = reason` stamped, and the call reports a transition

#### Scenario: Terminal run refused

- **WHEN** `markRunCanceledIfActive` runs against a `completed` or a `suspended_insufficient_funds` run
- **THEN** the row keeps its status, `completed_at`, and `error`, and the call reports no transition
