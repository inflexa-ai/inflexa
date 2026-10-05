# Conversation Run Awareness

## Purpose

Keep conversation agents accurately informed about asynchronous analysis work without persisting ephemeral activity or waking the agent on completion.

## Requirements

### Requirement: Empty, unavailable, and truncated activity are explicit

The Run Activity renderer SHALL explicitly state when the analysis has no non-terminal runs. If the activity read fails while the rest of turn preparation can continue, it SHALL render that run activity is temporarily unavailable and SHALL NOT imply that no run exists. The renderer SHALL include at most 20 detailed non-terminal rows and SHALL state the true total and omitted count when more rows exist.

#### Scenario: No non-terminal runs

- **GIVEN** an analysis has only terminal runs or no runs
- **WHEN** a chat turn is prepared
- **THEN** Run Activity explicitly states that no runs are currently running or suspended

#### Scenario: Activity read is unavailable

- **GIVEN** the run-activity database read fails
- **WHEN** the harness can otherwise prepare the conversation turn
- **THEN** Run Activity states that run status is temporarily unavailable
- **AND** it does not state or imply that no active runs exist

#### Scenario: More than twenty non-terminal runs

- **GIVEN** an analysis has more than 20 running or suspended runs
- **WHEN** Run Activity is rendered
- **THEN** it includes at most 20 detailed rows
- **AND** it reports the true non-terminal total and how many rows were omitted

### Requirement: Launch and prompt contracts prevent inspect polling loops

`execute_analysis` SHALL return the launched or deduplicated run's `runId` with `status: "in_progress"`. The conversation prompt and `inspect_run` description SHALL teach that workflows execute autonomously, bounded waiting is only for an explicit user request to wait, at most one bounded wait may be performed in a turn, and an `in_progress` cutoff result must be reported to the user without another immediate inspection.

#### Scenario: Newly launched run is explicitly in progress

- **WHEN** `execute_analysis` starts a new workflow
- **THEN** its model-visible result contains the run id and `status: "in_progress"`

#### Scenario: Deduplicated active launch is explicitly in progress

- **GIVEN** the requested plan or ad hoc invocation already has a non-terminal run
- **WHEN** `execute_analysis` returns the existing run
- **THEN** its model-visible result contains the existing run id and `status: "in_progress"`

#### Scenario: Wait cutoff ends inspection for the turn

- **GIVEN** `inspect_run` returns `inspectionState: "in_progress"` with `cutoffReached: true`
- **WHEN** the conversation agent follows its prompt
- **THEN** it reports that the run is still executing
- **AND** it does not call `inspect_run` again in that turn

### Requirement: Run completion remains pull-only

Completing a workflow SHALL update the harness run ledger and run-event stream but SHALL NOT append a completion message to conversation history or automatically invoke the conversation agent. A consumer MAY notify the user without starting a model turn.

#### Scenario: Workflow completes while no chat turn is active

- **WHEN** an analysis workflow reaches a terminal state
- **THEN** its ledger and stream expose the terminal state
- **AND** no conversation-agent invocation or thread-history write is created by completion

### Requirement: Conversation turns store fresh analysis-wide run activity after the user message

The harness MUST derive the Run Activity afresh from `cortex_runs` for the whole analysis on each chat turn. The render MUST separate `running` from `suspended_insufficient_funds`. It MUST give the full `runId`, the nullable `planId`, and the absolute `startedAt` of each run that it lists.

The render MUST NOT give the age of a run. An age changes each minute, and the record of the turn would then change on each turn.

The render is a context record of the kind `run-activity` (see the chat-turn capability), after the user message of the turn. The turn stores the record as a row of the turn only in two conditions:

- The history window holds no run-activity record.
- The text differs from the latest run-activity record in the window.

The harness MUST NOT write the render to the working memory.

#### Scenario: Running and suspended runs are listed

- **GIVEN** an analysis with one running run and one suspended run, and one of the two runs started from a different conversation thread
- **WHEN** a chat turn is prepared
- **THEN** the run-activity record lists both full run ids in separate Running and Suspended sections
- **AND** each entry carries its plan id when present and its absolute start time, and no entry carries an age

#### Scenario: An unchanged activity adds no record

- **GIVEN** a thread whose window holds a run-activity record, and no run of the analysis that changed after it
- **WHEN** the next turn is prepared
- **THEN** the turn adds no run-activity record, and the stored history stays an unchanged prefix

#### Scenario: A changed activity follows the user message

- **GIVEN** a thread whose window holds a run-activity record, and a run that started after it
- **WHEN** the next turn is prepared
- **THEN** the new run-activity record comes after the user message, and each earlier stored row does not change

#### Scenario: The render does not change with time

- **GIVEN** one set of non-terminal runs
- **WHEN** the harness renders it two times, one hour apart
- **THEN** the two renders are byte-identical
