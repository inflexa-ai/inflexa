# Spec Delta

## MODIFIED Requirements

### Requirement: Launch and prompt contracts prevent inspect polling loops

`execute_analysis` MUST return the launched or deduplicated run's `runId` with `status: "in_progress"`. `inspect_run` MUST end a bounded wait at its cutoff with `inspectionState: "in_progress"` and `wait.cutoffReached: true`, thus a turn never blocks on a run.

#### Scenario: Newly launched run is explicitly in progress

- **WHEN** `execute_analysis` starts a new workflow
- **THEN** its model-visible result contains the run id and `status: "in_progress"`

#### Scenario: Deduplicated active launch is explicitly in progress

- **GIVEN** the requested plan or ad hoc invocation already has a non-terminal run
- **WHEN** `execute_analysis` returns the existing run
- **THEN** its model-visible result contains the existing run id and `status: "in_progress"`

#### Scenario: Wait cutoff ends inspection for the turn

- **GIVEN** a run that stays in progress past the wait of an `inspect_run` call
- **WHEN** the wait reaches its cutoff
- **THEN** the result carries `inspectionState: "in_progress"` and `wait.cutoffReached: true`
