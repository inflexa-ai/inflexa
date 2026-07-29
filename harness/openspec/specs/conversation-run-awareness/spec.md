# Conversation Run Awareness

## Purpose

Keep conversation agents accurately informed about asynchronous analysis work without persisting ephemeral activity or waking the agent on completion.

## Requirements

### Requirement: Conversation turns receive fresh analysis-wide run activity

The harness SHALL inject a `[Run Activity]` user message into every analysis-scoped conversation turn after analysis context and before rendered working memory. The message SHALL be derived afresh from `cortex_runs` for the whole analysis, SHALL distinguish `running` from `suspended_insufficient_funds`, and SHALL carry each rendered run's full `runId`, nullable `planId`, absolute `startedAt`, and age at preparation time. The message SHALL NOT be persisted to thread history or working memory.

#### Scenario: Running and suspended runs are injected

- **GIVEN** an analysis has one running run and one suspended run, including a run launched from another conversation thread
- **WHEN** a chat turn is prepared
- **THEN** the Run Activity tail message lists both full run ids in separate Running and Suspended sections
- **AND** each entry carries its plan id when present, absolute start time, and current age

#### Scenario: Run activity remains outside persisted history

- **WHEN** a prepared turn is passed through the agent loop and appended to thread history
- **THEN** the persisted turn contains the genuine user message and loop output
- **AND** it contains no Run Activity tail message

#### Scenario: Run activity preserves the cacheable prefix

- **GIVEN** a thread has persisted conversation history
- **WHEN** a new turn is assembled
- **THEN** the history remains an unchanged prefix
- **AND** Run Activity appears only in the ephemeral tail

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
