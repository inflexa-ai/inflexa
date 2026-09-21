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
