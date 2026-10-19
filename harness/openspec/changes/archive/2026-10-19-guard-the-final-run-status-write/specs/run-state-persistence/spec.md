## MODIFIED Requirements

### Requirement: Run query helpers

The state module SHALL export the following helpers, each taking a
`pg.Pool`/`PoolClient` (`Querier`) first and returning `ResultAsync<…, DbError>`
(absence rides the ok channel as `null`/`[]`):

- `insertRun(pool, { runId, analysisId, threadId?, workflowName, planId?, mandateJti?, mandateExpiresAt? })`: inserts with `status='running'` and `started_at`. On the `idx_cortex_runs_active_plan` collision it SHALL throw `RunDedupCollisionError` verbatim ABOVE the Result boundary (a control-flow signal, not a `DbError`); the caller recovers via `queryActiveRun`. The input SHALL NOT accept `workflowId`.
- `updateRunStatus(pool, runId, status, error?)`: changes the status and the error of the row only when the status of the row is `running`. It sets `completed_at` for the terminal statuses `completed`/`partial`/`failed`/`canceled`/`suspended_insufficient_funds`. It returns whether a row changed. A row that is not `running` keeps its status, its `completed_at`, and its error.
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

- **GIVEN** a `running` run row
- **WHEN** `updateRunStatus(pool, runId, "suspended_insufficient_funds", "budget_exceeded")` is called
- **THEN** the row reads `suspended_insufficient_funds` with `error = "budget_exceeded"` and `completed_at` set
- **AND** the call returns `true`

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
