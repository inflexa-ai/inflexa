## MODIFIED Requirements

### Requirement: Conversation turns receive fresh analysis-wide run activity

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
