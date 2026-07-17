## MODIFIED Requirements

### Requirement: cortex_runs table schema

The system SHALL maintain a `cortex_runs` table with: `run_id` (TEXT, PRIMARY
KEY — equal to the DBOS workflowID, a bare UUID), `analysis_id` (TEXT, NOT NULL),
`thread_id` (TEXT, nullable), `workflow_name` (TEXT, NOT NULL), `status` (TEXT,
NOT NULL), `started_at` (TEXT, NOT NULL), `completed_at` (TEXT, nullable),
`error` (TEXT, nullable), `parts` (JSONB, nullable — vestigial), `mandate_jti`
(TEXT, nullable), `mandate_expires_at` (TEXT, nullable), `plan_id` (TEXT,
nullable — dedup key, FK to `cortex_plans`), `attempt_count` (INTEGER, NOT
NULL DEFAULT 0 — parent-workflow resume counter), `synthesis_status` (TEXT,
nullable — the run's synthesis outcome, one of `produced`,
`skipped_no_summaries`, `skipped_blocker`, `failed`; NULL means unknown, e.g.
synthesis disabled, never reached, or a legacy row), and `synthesis_reason`
(TEXT, nullable — the human-readable blocker/skip/failure reason; NULL for
`produced`).

Indexes SHALL exist on `(analysis_id)` and `(thread_id)`. A partial-unique index
`idx_cortex_runs_active_plan` SHALL exist on `(analysis_id, plan_id) WHERE status
IN ('running','suspended_insufficient_funds')`. The table SHALL NOT have a
`workflow_id` column (`run_id` IS the workflowID), SHALL NOT have a
`mandate_token` column, and SHALL have NO `plan`, `plan_version`, `current_wave`,
or `suspension` columns — those are dropped on startup via `DROP COLUMN IF
EXISTS`. `synthesis_status` and `synthesis_reason` SHALL be added additively via
`ADD COLUMN IF NOT EXISTS`, so an existing database gains them with all rows NULL
and no backfill.

#### Scenario: Run created at workflow launch time

- **WHEN** `executePlan` runs the INSERT after the dedup pre-check passes
- **THEN** a row is inserted with the bare-UUID `run_id`, `analysis_id`, `thread_id`, `plan_id`, `workflow_name = "executeAnalysis"`, `status = "running"`, and `started_at`
- **AND** `parts`, `completed_at`, `error`, `synthesis_status`, and `synthesis_reason` are NULL and `attempt_count` is `0`
- **AND** no `workflow_id` column write is attempted

#### Scenario: Vestigial and dropped columns removed on startup

- **WHEN** the state module initialises
- **THEN** `workflow_id`, `mandate_token`, `plan`, `plan_version`, `current_wave`, and `suspension` SHALL be dropped from `cortex_runs` if present, idempotently

#### Scenario: Synthesis columns present on both fresh and migrated databases

- **WHEN** the state module initialises against a fresh database AND against a pre-migration database whose `cortex_runs` predates these columns
- **THEN** both databases have `synthesis_status` and `synthesis_reason` columns
- **AND** pre-existing rows read `synthesis_status = NULL` with no backfill

### Requirement: CortexRunRow schema

The `CortexRunRow` Zod schema SHALL define: `runId`, `analysisId`, `threadId`
(nullable), `workflowName`, `status` (enum: `"running"`, `"completed"`,
`"partial"`, `"failed"`, `"canceled"`, `"suspended_insufficient_funds"`),
`startedAt`, `completedAt` (nullable), `error` (nullable), `parts` (array of any,
nullable), `mandateJti` (nullable), `mandateExpiresAt` (nullable), `planId`
(nullable), `attemptCount` (non-negative integer, default 0), `synthesisStatus`
(enum: `"produced"`, `"skipped_no_summaries"`, `"skipped_blocker"`, `"failed"`;
nullable — NULL means unknown), and `synthesisReason` (nullable). The schema
SHALL NOT contain a `workflowId` or `mandateToken` field.

#### Scenario: Run status values

- **WHEN** a run status is validated
- **THEN** the valid values are `"running"`, `"completed"`, `"partial"`, `"failed"`, `"canceled"`, and `"suspended_insufficient_funds"`

#### Scenario: Synthesis status values

- **WHEN** a `synthesisStatus` is validated
- **THEN** the valid non-null values are `"produced"`, `"skipped_no_summaries"`, `"skipped_blocker"`, and `"failed"`
- **AND** a NULL column parses to a null `synthesisStatus` (unknown)

#### Scenario: workflowId field is absent

- **WHEN** a `CortexRunRow` is parsed
- **THEN** the result has no `workflowId` field, and callers read `row.runId` instead

### Requirement: Run query helpers

The state module SHALL export the following helpers, each taking a
`pg.Pool`/`PoolClient` (`Querier`) first and returning `ResultAsync<…, DbError>`
(absence rides the ok channel as `null`/`[]`):

- `insertRun(pool, { runId, analysisId, threadId?, workflowName, planId?, mandateJti?, mandateExpiresAt? })`: inserts with `status='running'` and `started_at`. On the `idx_cortex_runs_active_plan` collision it SHALL throw `RunDedupCollisionError` verbatim ABOVE the Result boundary (a control-flow signal, not a `DbError`); the caller recovers via `queryActiveRun`. The input SHALL NOT accept `workflowId`.
- `updateRunStatus(pool, runId, status, error?)`: updates status; sets `completed_at` for the terminal statuses `completed`/`partial`/`failed`/`canceled`. It SHALL NOT write the synthesis columns.
- `setRunSynthesisOutcome(pool, runId, synthesisStatus, synthesisReason?)`: writes `synthesis_status` and `synthesis_reason` for a run (mirroring `setRunMandate`'s focused-column-write shape). Called by the terminal finalisation when synthesis ran.
- `promoteFailedToPartial(pool, runId)`: atomically flips `status` from `'failed'` to `'partial'` and returns whether a row changed.
- `bumpRunAttemptCount(pool, runId)`: atomically increments and returns `attempt_count`; a missing row is an invariant violation surfaced on the err channel.
- `setRunMandate(pool, runId, jti, expiresAt)`: writes the run-mandate audit columns (no `token` parameter — the column does not exist).
- `queryRun(pool, runId)`: returns one `CortexRunRow` or null, including `synthesisStatus` and `synthesisReason`.
- `queryActiveRun(pool, analysisId, planId)`: returns the single `running`/`suspended_insufficient_funds` row for `(analysisId, planId)` or null.
- `queryRunsByAnalysis(pool, analysisId, { limit?, offset? })`: returns runs for an analysis ordered by `started_at DESC`, including the synthesis columns.
- `queryRunsByThread(pool, analysisId, threadId, { limit?, offset? })`: returns runs for a thread (scoped to the analysis) ordered by `started_at DESC`.

There SHALL be NO `updateRunParts`, `failOrphanedRuns`, `failOrphanedSteps`, or
`queryGlobalSyncStatus` helper.

#### Scenario: Insert and query a run

- **WHEN** `insertRun(pool, { runId: "uuid-1", analysisId: "a-1", threadId: "t-1", planId: "p-1", workflowName: "executeAnalysis" })` then `queryRun(pool, "uuid-1")` are called
- **THEN** the result includes `runId: "uuid-1"`, `status: "running"`, `parts: null`, `attemptCount: 0`, `synthesisStatus: null`, `synthesisReason: null`, and no `workflowId` field

#### Scenario: setRunSynthesisOutcome records the outcome

- **GIVEN** a `cortex_runs` row for `runId = "uuid-1"`
- **WHEN** `setRunSynthesisOutcome(pool, "uuid-1", "skipped_blocker", "no synthesizable content")` is called, then `queryRun(pool, "uuid-1")` is called
- **THEN** the returned row has `synthesisStatus: "skipped_blocker"` and `synthesisReason: "no synthesizable content"`

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
