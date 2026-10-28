## MODIFIED Requirements

### Requirement: cortex_runs table schema

The system SHALL maintain a `cortex_runs` table with: `run_id` (TEXT, PRIMARY
KEY — equal to the DBOS workflowID, a bare UUID), `analysis_id` (TEXT, NOT NULL),
`thread_id` (TEXT, nullable), `workflow_name` (TEXT, NOT NULL), `status` (TEXT,
NOT NULL), `started_at` (TEXT, NOT NULL), `completed_at` (TEXT, nullable),
`error` (TEXT, nullable), `parts` (JSONB, nullable — vestigial), `mandate_id`
(TEXT, nullable — the reference to the run credential, with no expiry, because the run does not depend on a clock),
and `plan_id` (TEXT,
nullable — planned-run dedup and internal-plan reference, FK to
`cortex_plans`). There MUST be no `attempt_count` column. It was the resume counter of the parent workflow, for an
`executeAnalysis` entry point that resumes a run after a suspension. That entry point does not exist.

Indexes SHALL exist on `(analysis_id)` and `(thread_id)`. A partial-unique index
`idx_cortex_runs_active_plan` SHALL exist on `(analysis_id, plan_id) WHERE status
= 'running'`. The table SHALL NOT have a
`workflow_id` column (`run_id` IS the workflowID), SHALL NOT have a
`mandate_token` column, and SHALL have NO `mandate_jti`, `mandate_expires_at`, `plan`, `plan_version`,
`current_wave`, or `suspension` columns — those are dropped or renamed by a migration. A database that has
`mandate_jti` keeps its values under `mandate_id`.

#### Scenario: Run created at workflow launch time

- **WHEN** `execute_analysis` reserves the row after mode-specific validation
- **THEN** a row is inserted with the bare-UUID `run_id`, `analysis_id`, `thread_id`, `plan_id`, `workflow_name = "executeAnalysis"`, `status = "running"`, and `started_at`
- **AND** `parts`, `completed_at`, `error` are NULL
- **AND** no `workflow_id` column write is attempted

#### Scenario: Vestigial and dropped columns removed on startup

- **WHEN** the state module initialises
- **THEN** `workflow_id`, `mandate_token`, `mandate_expires_at`, `plan`, `plan_version`, `current_wave`, and `suspension` SHALL be dropped from `cortex_runs` if present, idempotently
- **AND** `mandate_jti` SHALL become `mandate_id` with its values, or SHALL be dropped when `mandate_id` already stands

### Requirement: CortexRunRow schema

The `CortexRunRow` Zod schema SHALL define: `runId`, `analysisId`, `threadId`
(nullable), `workflowName`, `status` (enum: `"running"`, `"completed"`,
`"partial"`, `"failed"`, `"canceled"`),
`startedAt`, `completedAt` (nullable), `error` (nullable), `parts` (array of any,
nullable), `mandateId` (nullable), and `planId`
(nullable). The schema SHALL NOT contain a `workflowId`, `mandateToken`, or
`attemptCount` field.

#### Scenario: Run status values

- **WHEN** a run status is validated
- **THEN** the valid values are `"running"`, `"completed"`, `"partial"`, `"failed"`, and `"canceled"`

#### Scenario: workflowId field is absent

- **WHEN** a `CortexRunRow` is parsed
- **THEN** the result has no `workflowId` field, and callers read `row.runId` instead

### Requirement: The state module gives the run query helpers

The state module MUST export these helpers. Each helper takes a `pg.Pool` or a
`PoolClient` (`Querier`) first, and it gives `ResultAsync<…, DbError>`. Absence
rides the ok channel as `null` or `[]`:

- `insertRun(pool, { runId, analysisId, threadId?, workflowName, planId?, mandateId? })`: inserts with `status='running'` and `started_at`. On the `idx_cortex_runs_active_plan` collision it MUST throw `RunDedupCollisionError` verbatim, above the Result boundary. That error is a control-flow signal, not a `DbError`. The caller recovers with `queryActiveRun`. The input MUST NOT accept `workflowId`.
- `updateRunStatus(pool, runId, status, error?)`: changes the status and the error of the row only when the status of the row is `running`. It sets `completed_at` for the terminal statuses `completed`/`partial`/`failed`/`canceled`. It returns whether a row changed. A row that is not `running` keeps its status, its `completed_at`, and its error.
- `promoteFailedToPartial(pool, runId)`: atomically flips `status` from `'failed'` to `'partial'` and returns whether a row changed.
- `setRunMandate(pool, runId, jti, expiresAt)`: writes the run-mandate audit columns (no `token` parameter — the column does not exist).
- `queryRun(pool, runId)`: returns one `CortexRunRow` or null.
- `queryActiveRun(pool, analysisId, planId)`: returns the single `running` row for `(analysisId, planId)` or null.
- `queryRunsByAnalysis(pool, analysisId, { limit?, offset?, q? })`: returns runs for an analysis ordered by `started_at DESC`.
- `countRunsByAnalysis(pool, analysisId, { q? })`: returns the count of the runs of an analysis that `q` selects, in one statement. The package root exports it.
- `queryRunsByThread(pool, analysisId, threadId, { limit?, offset?, q? })`: returns runs for a thread (scoped to the analysis) ordered by `started_at DESC`.
- `queryActiveRunsByAnalysis(pool, analysisId, { q? })`: returns the `running` runs of an analysis ordered by `started_at DESC`.

The active set of each run query is `running` only. `running` is the one
non-terminal run status. A run with a paused step is `running`.

The text filter `q` MUST select a run in each of these cases:

- The run id holds the text.
- The stored plan of the run has a string `title` that holds the text.

The match MUST have no regard to case. Each character of `q` MUST match only
itself, thus `%` and `_` are not wildcards. The plan of a run is the
`cortex_plans` row of its `plan_id` in the same analysis. Thus a run with no
plan, or with a plan that is gone, matches by its run id only. An absent `q`
MUST select each run. The filter MUST apply before the limit and the offset,
and it MUST NOT change the order of a read.

There MUST be no `updateRunParts`, `failOrphanedRuns`, `failOrphanedSteps`,
`queryGlobalSyncStatus`, or `bumpRunAttemptCount` helper. The last one went
away with the resume-counter scaffolding.

#### Scenario: Insert and query a run

- **WHEN** `insertRun(pool, { runId: "uuid-1", analysisId: "a-1", threadId: "t-1", planId: "p-1", workflowName: "executeAnalysis" })` then `queryRun(pool, "uuid-1")` are called
- **THEN** the result includes `runId: "uuid-1"`, `status: "running"`, `parts: null`, and no `workflowId` field

#### Scenario: queryActiveRun recovers from a dedup collision

- **GIVEN** an active row for `("a-1","p-1")` with `run_id = "uuid-existing"`
- **WHEN** a second `insertRun` for `("a-1","p-1")` throws `RunDedupCollisionError`
- **AND** the caller calls `queryActiveRun(pool, "a-1", "p-1")`
- **THEN** the row with `run_id = "uuid-existing"` is returned

#### Scenario: A status write does not overwrite a canceled run

- **GIVEN** a run row that the run canceler changed to `canceled` with the error `external_cancel`
- **WHEN** `updateRunStatus(pool, runId, "completed")` is called
- **THEN** the row keeps the status `canceled`, its `completed_at`, and the error `external_cancel`
- **AND** the call returns `false`

#### Scenario: A status write does not overwrite a different terminal status

- **GIVEN** a run row with the status `completed`
- **WHEN** `updateRunStatus(pool, runId, "failed", "workflow start failed")` is called
- **THEN** the row keeps the status `completed`, its `completed_at`, and its error
- **AND** the call returns `false`

#### Scenario: A status write for an unknown run changes nothing

- **WHEN** `updateRunStatus` is called with a `runId` that has no row
- **THEN** the call returns `false`

#### Scenario: promoteFailedToPartial rescues a failed run

- **GIVEN** a `cortex_runs` row with `status = 'failed'`
- **WHEN** `promoteFailedToPartial(pool, runId)` is called
- **THEN** the row's `status` becomes `'partial'` and the function returns `true`
- **AND** a second call returns `false` (no longer `failed`)

#### Scenario: A text finds the runs by the plan title or the run id

- **GIVEN** analysis `a1` with run `r-old` of the plan titled "Gene index", run `r-mid` of the plan titled "Pathway enrichment", and run `r-dex9` with no plan
- **AND** the runs started in this order: `r-old`, `r-mid`, `r-dex9`
- **WHEN** `queryRunsByAnalysis(pool, "a1", { q: "DEX" })` and `countRunsByAnalysis(pool, "a1", { q: "DEX" })` are called
- **THEN** the read gives `r-dex9` and then `r-old`, and the count is 2

#### Scenario: A text selects the runs before the window

- **GIVEN** analysis `a1` with 3 runs whose plan title holds "volcano", and 5 newer runs whose title does not
- **WHEN** `queryRunsByAnalysis(pool, "a1", { q: "volcano", limit: 2, offset: 0 })` is called
- **THEN** it gives the two newest of the 3 matching runs
- **AND** `countRunsByAnalysis(pool, "a1", { q: "volcano" })` gives 3

#### Scenario: A wildcard character of the text matches only itself

- **GIVEN** analysis `a1` with run `r1` of the plan titled "a_b" and run `r2` of the plan titled "axb"
- **WHEN** `queryRunsByAnalysis(pool, "a1", { q: "a_b" })` is called
- **THEN** it gives only `r1`

#### Scenario: A plan of a different analysis gives no title

- **GIVEN** run `r1` of analysis `a1` whose `plan_id` names a plan of analysis `a2` titled "volcano"
- **WHEN** `queryRunsByAnalysis(pool, "a1", { q: "volcano" })` is called
- **THEN** it gives no run

#### Scenario: The text combines with the thread and with the active set

- **GIVEN** analysis `a1` with a running run `r1` and a completed run `r2` in thread `t1`, each with a plan whose title holds "volcano"
- **AND** a running run `r3` in thread `t2` with a plan whose title holds "volcano"
- **AND** a running run `r4` in thread `t1` with a plan whose title does not hold "volcano"
- **WHEN** `queryRunsByThread(pool, "a1", "t1", { q: "volcano" })` and `queryActiveRunsByAnalysis(pool, "a1", { q: "volcano" })` are called
- **THEN** the thread read gives `r1` and `r2`, and the active read gives `r1` and `r3`

#### Scenario: No text selects each run

- **GIVEN** analysis `a1` with 4 runs
- **WHEN** `countRunsByAnalysis(pool, "a1")` is called
- **THEN** it gives 4
