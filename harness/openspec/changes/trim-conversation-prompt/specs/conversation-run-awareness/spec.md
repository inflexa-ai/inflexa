# Spec Delta

## MODIFIED Requirements

### Requirement: Launch and prompt contracts prevent inspect polling loops

`execute_analysis` MUST return the launched or deduplicated run's `runId` with `status: "in_progress"`. The `inspect_run` description MUST teach that a run never posts its completion into the conversation. It MUST teach that `waitForTerminalSeconds` is for a check that the user directs. The wait occurs once, for 1-30 seconds, and an `in_progress` result at the cutoff ends the polling for that turn.

The conversation prompt MUST state that runs are asynchronous and that `inspect_run` reads their results on a later turn. The prompt MUST NOT restate the wait rule, because the model reads the description at the call.

#### Scenario: Newly launched run is explicitly in progress

- **WHEN** `execute_analysis` starts a new workflow
- **THEN** its model-visible result contains the run id and `status: "in_progress"`

#### Scenario: Deduplicated active launch is explicitly in progress

- **GIVEN** the requested plan or ad hoc invocation already has a non-terminal run
- **WHEN** `execute_analysis` returns the existing run
- **THEN** its model-visible result contains the existing run id and `status: "in_progress"`

#### Scenario: Wait cutoff ends inspection for the turn

- **GIVEN** `inspect_run` returns `inspectionState: "in_progress"` with `cutoffReached: true`
- **WHEN** the conversation agent obeys the `inspect_run` description
- **THEN** it reports that the run is still executing
- **AND** it does not call `inspect_run` again in that turn

#### Scenario: The wait rule is in the tool description, not in the prompt

- **WHEN** the conversation agent is assembled
- **THEN** the `inspect_run` description states that `waitForTerminalSeconds` can wait once for 1-30 seconds
- **AND** the system prompt does not name `waitForTerminalSeconds`
