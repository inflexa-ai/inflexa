## MODIFIED Requirements

### Requirement: cortex_runs table schema

The system SHALL maintain a `cortex_runs` table with: `run_id` (TEXT, PRIMARY
KEY — equal to the DBOS workflowID, a bare UUID), `analysis_id` (TEXT, NOT NULL),
`thread_id` (TEXT, nullable), `workflow_name` (TEXT, NOT NULL), `status` (TEXT,
NOT NULL), `started_at` (TEXT, NOT NULL), `completed_at` (TEXT, nullable),
`error` (TEXT, nullable), `parts` (JSONB, nullable — vestigial), `mandate_jti`
(TEXT, nullable), `mandate_expires_at` (TEXT, nullable), and `plan_id` (TEXT,
nullable — planned-run dedup and internal-plan reference, FK to
`cortex_plans`). There SHALL be NO `attempt_count` column: it was the
parent-workflow resume counter for an `executeAnalysis` resume-after-402 entry
point that was never built, and is removed.

Indexes SHALL exist on `(analysis_id)` and `(thread_id)`. A partial-unique index
`idx_cortex_runs_active_plan` SHALL exist on `(analysis_id, plan_id) WHERE status
IN ('running','suspended_insufficient_funds')`. The table SHALL NOT have a
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

## ADDED Requirements

### Requirement: Ad hoc run reservation is idempotent by deterministic run id

The state layer SHALL provide an analysis-scoped insert-if-absent reservation
for an ad hoc run whose caller supplies a deterministic bare UUID `runId`.
After insert or conflict it SHALL reload by `(analysisId, runId)`. A row in
another analysis SHALL never be returned. Reusing an existing row SHALL be a
successful idempotent outcome regardless of its active or terminal status; it
SHALL NOT create a second row or authorize a second run.

#### Scenario: Duplicate delivery finds an active run

- **GIVEN** an active row already exists for the invocation-derived `runId`
- **WHEN** the same ad hoc invocation reserves again
- **THEN** reservation returns that row and creates no new row

#### Scenario: Duplicate delivery finds a terminal run

- **GIVEN** a completed row already exists for the invocation-derived `runId`
- **WHEN** the same ad hoc invocation is redelivered
- **THEN** reservation returns the completed row rather than treating the terminal partial-index predicate as permission to re-run

#### Scenario: Run id belongs to another analysis

- **GIVEN** a row with the derived `runId` exists under a different analysis
- **WHEN** reservation reloads it under the current analysis id
- **THEN** it returns no foreign row and surfaces the identity collision as an error
