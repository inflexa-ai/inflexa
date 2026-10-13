## MODIFIED Requirements

### Requirement: Empty, unavailable, and truncated activity are explicit

The Run Activity renderer SHALL explicitly state when the analysis has no non-terminal runs. A non-terminal run is a run whose status is `running`. If the activity read fails while the rest of turn preparation can continue, it SHALL render that run activity is temporarily unavailable and SHALL NOT imply that no run exists. The renderer SHALL include at most 20 detailed non-terminal rows and SHALL state the true total and omitted count when more rows exist.

#### Scenario: No non-terminal runs

- **GIVEN** an analysis has only terminal runs or no runs
- **WHEN** a chat turn is prepared
- **THEN** Run Activity explicitly states that no runs are currently running

#### Scenario: Activity read is unavailable

- **GIVEN** the run-activity database read fails
- **WHEN** the harness can otherwise prepare the conversation turn
- **THEN** Run Activity states that run status is temporarily unavailable
- **AND** it does not state or imply that no active runs exist

#### Scenario: More than twenty non-terminal runs

- **GIVEN** an analysis has more than 20 running runs
- **WHEN** Run Activity is rendered
- **THEN** it includes at most 20 detailed rows
- **AND** it reports the true non-terminal total and how many rows were omitted

## REMOVED Requirements

### Requirement: Conversation turns store fresh analysis-wide run activity after the user message

**Reason**: The render lists the `running` runs only, because `suspended_insufficient_funds` is a terminal run status. The scenario "Running and suspended runs are listed" is false under that rule. The requirement "Conversation turns store the fresh run activity of the running runs after the user message" replaces this requirement.

**Migration**: None. The replacement keeps each other rule of this requirement.

## ADDED Requirements

### Requirement: Conversation turns store the fresh run activity of the running runs after the user message

The harness MUST derive the Run Activity afresh from `cortex_runs` for the whole analysis on each chat turn. The render MUST list the `running` runs only. A `suspended_insufficient_funds` run is terminal, thus the render MUST NOT list it. It MUST give the full `runId`, the nullable `planId`, and the absolute `startedAt` of each run that it lists.

The render MUST NOT give the age of a run. An age changes each minute, and the record of the turn would then change on each turn.

The render is a context record of the kind `run-activity` (see the chat-turn capability), after the user message of the turn. The turn stores the record as a row of the turn only in two conditions:

- The history window holds no run-activity record.
- The text differs from the latest run-activity record in the window.

The harness MUST NOT write the render to the working memory.

#### Scenario: Running runs are listed and a suspended run is not

- **GIVEN** an analysis with two running runs and one suspended run, and one of the running runs started from a different conversation thread
- **WHEN** a chat turn is prepared
- **THEN** the run-activity record lists the full run id of each running run, and it does not list the suspended run
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
