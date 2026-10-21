## MODIFIED Requirements

### Requirement: Run query helpers

The state module MUST export these helpers. Each helper takes a `pg.Pool` or a
`PoolClient` (`Querier`) first, and it gives `ResultAsync<…, DbError>`. Absence
rides the ok channel as `null` or `[]`:

- `insertRun(pool, { runId, analysisId, threadId?, workflowName, planId?, mandateJti?, mandateExpiresAt? })`: inserts with `status='running'` and `started_at`. On the `idx_cortex_runs_active_plan` collision it MUST throw `RunDedupCollisionError` verbatim, above the Result boundary. That error is a control-flow signal, not a `DbError`. The caller recovers with `queryActiveRun`. The input MUST NOT accept `workflowId`.
- `updateRunStatus(pool, runId, status, error?)`: changes the status and the error of the row only when the status of the row is `running`. It sets `completed_at` for the terminal statuses `completed`/`partial`/`failed`/`canceled`/`suspended_insufficient_funds`. It returns whether a row changed. A row that is not `running` keeps its status, its `completed_at`, and its error.
- `promoteFailedToPartial(pool, runId)`: atomically flips `status` from `'failed'` to `'partial'` and returns whether a row changed.
- `setRunMandate(pool, runId, jti, expiresAt)`: writes the run-mandate audit columns (no `token` parameter — the column does not exist).
- `queryRun(pool, runId)`: returns one `CortexRunRow` or null.
- `queryActiveRun(pool, analysisId, planId)`: returns the single `running` row for `(analysisId, planId)` or null.
- `queryRunsByAnalysis(pool, analysisId, { limit?, offset?, q? })`: returns runs for an analysis ordered by `started_at DESC`.
- `countRunsByAnalysis(pool, analysisId, { q? })`: returns the count of the runs of an analysis that `q` selects, in one statement. The package root exports it.
- `queryRunsByThread(pool, analysisId, threadId, { limit?, offset?, q? })`: returns runs for a thread (scoped to the analysis) ordered by `started_at DESC`.
- `queryActiveRunsByAnalysis(pool, analysisId, { q? })`: returns the `running` runs of an analysis ordered by `started_at DESC`.

The active set of each run query is `running` only. `running` is the one
non-terminal run status.

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
