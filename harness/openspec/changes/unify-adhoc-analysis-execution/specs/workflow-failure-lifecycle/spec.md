## MODIFIED Requirements

### Requirement: The run row exists before the workflow body runs

The `cortex_runs` row SHALL be reserved by `execute_analysis` at the async edge
for either mode — BEFORE `DBOS.startWorkflow` launches `executeAnalysis`. The
workflow body's `validateAndInit` SHALL NOT insert the row; it only sanity-checks
that the pre-inserted row matches its `analysisId`, `planId`, and `runId`.
Because the row always pre-exists, `collectAndComplete` always has a row to
finalise — there is no "no row to update" terminal path.

#### Scenario: Plan mode reserves the row before launch

- **WHEN** `execute_analysis` plan mode is invoked for a validated plan with no active run
- **THEN** it inserts the `cortex_runs` row with `status = "running"` and a bare-UUID `runId`, authorizes the run, and only then starts `executeAnalysis` under that same `runId`

#### Scenario: Ad hoc mode reserves by invocation identity

- **WHEN** `execute_analysis` ad hoc mode has persisted its internal plan
- **THEN** it idempotently reserves the invocation-derived `runId`, authorizes a newly reserved run, and only then starts `executeAnalysis` under that same id

#### Scenario: Run authorization failure never starts a workflow

- **WHEN** `runAuthorizer.authorize` throws after a new run row was reserved
- **THEN** `execute_analysis` updates that row to `status = "failed"` with error `"run authorization failed"` and rethrows
- **AND** no `executeAnalysis` workflow is started, so `collectAndComplete` never runs for it

## ADDED Requirements

### Requirement: Disabled synthesis is a successful terminal path

When `ExecuteAnalysisInput.synthesisEnabled` resolves false, the parent SHALL
skip synthesis without treating the absence of a synthesis outcome as a
failure. `collectAndComplete` SHALL derive terminal status from the ordinary
step outcomes and SHALL still close the charge, revoke owned authorization,
persist terminal state, and emit the terminal run event.

#### Scenario: One ad hoc step completes

- **GIVEN** an ad hoc run whose only step completed and whose synthesis is disabled
- **WHEN** `collectAndComplete` runs
- **THEN** the run reaches `completed`
- **AND** no synthesis failure or missing-synthesis error is recorded
