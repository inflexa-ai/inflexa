# run-state-persistence — delta

> Decision 4 resolved (retire the resume scaffolding): the `executeAnalysis`
> resume-after-402 entry point ("change 9") was never built, so the parent-
> workflow resume counter it existed to serve — the `cortex_runs.attempt_count`
> column, the `CortexRunRow.attemptCount` field, and the `bumpRunAttemptCount`
> helper — is removed. The 402-pause / `suspended_insufficient_funds` state
> itself is retained (see `workflow-failure-lifecycle`); only the resume-counter
> scaffolding goes. A future resume capability re-introduces its own cache-
> busting mechanism.

## MODIFIED Requirements

### Requirement: cortex_runs table schema

The system SHALL maintain a `cortex_runs` table with: `run_id` (TEXT, PRIMARY
KEY — equal to the DBOS workflowID, a bare UUID), `analysis_id` (TEXT, NOT NULL),
`thread_id` (TEXT, nullable), `workflow_name` (TEXT, NOT NULL), `status` (TEXT,
NOT NULL), `started_at` (TEXT, NOT NULL), `completed_at` (TEXT, nullable),
`error` (TEXT, nullable), `parts` (JSONB, nullable — vestigial), `mandate_jti`
(TEXT, nullable), `mandate_expires_at` (TEXT, nullable), and `plan_id` (TEXT,
nullable — dedup key, FK to `cortex_plans`). There SHALL be NO `attempt_count`
column: it was the parent-workflow resume counter for an `executeAnalysis`
resume-after-402 entry point that was never built, and is removed.

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
- **AND** `parts`, `completed_at`, `error` are NULL
- **AND** no `workflow_id` column write is attempted

#### Scenario: Vestigial and dropped columns removed on startup

- **WHEN** the state module initialises
- **THEN** `workflow_id`, `mandate_token`, `plan`, `plan_version`, `current_wave`, and `suspension` SHALL be dropped from `cortex_runs` if present, idempotently

### Requirement: CortexRunRow schema

The `CortexRunRow` Zod schema SHALL define: `runId`, `analysisId`, `threadId`
(nullable), `workflowName`, `status` (enum: `"running"`, `"completed"`,
`"partial"`, `"failed"`, `"canceled"`, `"suspended_insufficient_funds"`),
`startedAt`, `completedAt` (nullable), `error` (nullable), `parts` (array of any,
nullable), `mandateJti` (nullable), `mandateExpiresAt` (nullable), and `planId`
(nullable). The schema SHALL NOT contain a `workflowId`, `mandateToken`, or
`attemptCount` field.

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
- `setRunMandate(pool, runId, jti, expiresAt)`: writes the run-mandate audit columns (no `token` parameter — the column does not exist).
- `queryRun(pool, runId)`: returns one `CortexRunRow` or null.
- `queryActiveRun(pool, analysisId, planId)`: returns the single `running`/`suspended_insufficient_funds` row for `(analysisId, planId)` or null.
- `queryRunsByAnalysis(pool, analysisId, { limit?, offset? })`: returns runs for an analysis ordered by `started_at DESC`.
- `queryRunsByThread(pool, analysisId, threadId, { limit?, offset? })`: returns runs for a thread (scoped to the analysis) ordered by `started_at DESC`.

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

#### Scenario: promoteFailedToPartial rescues a failed run

- **GIVEN** a `cortex_runs` row with `status = 'failed'`
- **WHEN** `promoteFailedToPartial(pool, runId)` is called
- **THEN** the row's `status` becomes `'partial'` and the function returns `true`
- **AND** a second call returns `false` (no longer `failed`)
