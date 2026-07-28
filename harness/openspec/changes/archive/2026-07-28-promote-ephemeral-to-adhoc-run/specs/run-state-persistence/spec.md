## ADDED Requirements

### Requirement: Adhoc runs are plan-less run rows

An adhoc run SHALL be recorded as a `cortex_runs` row inserted via `insertRun` with `workflow_name = "runAdhoc"` and `planId` omitted (stored `plan_id = NULL`). No schema change is required: `plan_id` is already nullable and `insertRun` already accepts an optional `planId`. Consumers SHALL treat `plan_id IS NULL` as the adhoc-run discriminator.

#### Scenario: Adhoc run inserts a null-plan row

- **WHEN** `insertRun(pool, { runId: "r-1", analysisId: "a-1", threadId: "t-1", workflowName: "runAdhoc" })` then `queryRun(pool, "r-1")` are called
- **THEN** the returned row has `workflowName = "runAdhoc"`, `planId = null`, `status = "running"`, and a set `startedAt`

### Requirement: The active-run index does not constrain plan-less runs

The partial-unique index `idx_cortex_runs_active_plan` on `(analysis_id, plan_id) WHERE status IN (active states)` SHALL NOT constrain rows with `plan_id = NULL`, because SQL treats NULLs as distinct. `insertRun` for a `runAdhoc` row SHALL NOT raise `RunDedupCollisionError`, and multiple concurrent adhoc runs in the same analysis SHALL be permitted.

#### Scenario: Concurrent adhoc runs do not collide

- **GIVEN** an active adhoc run exists for `analysis_id = "a-1"` with `plan_id = NULL`
- **WHEN** a second `insertRun(pool, { runId: "r-2", analysisId: "a-1", workflowName: "runAdhoc" })` is called
- **THEN** it inserts successfully without raising `RunDedupCollisionError`
