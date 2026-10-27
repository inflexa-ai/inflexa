## ADDED Requirements

### Requirement: A turn stores the fresh run activity of the running runs after the user message

The harness MUST derive the Run Activity afresh from `cortex_runs` for the whole analysis on each chat turn. The render MUST list the `running` runs only. A run with a paused step is `running`, thus the render lists it. It MUST give the full `runId`, the nullable `planId`, and the absolute `startedAt` of each run that it lists.

The render MUST NOT give the age of a run. An age changes each minute, and the record of the turn would then change on each turn.

The render is a context record of the kind `run-activity` (see the chat-turn capability), after the user message of the turn. The turn stores the record as a row of the turn only in two conditions:

- The history window holds no run-activity record.
- The text differs from the latest run-activity record in the window.

The harness MUST NOT write the render to the working memory.

#### Scenario: Running runs are listed and an ended run is not

- **GIVEN** an analysis with two running runs and one failed run, and one of the running runs started from a different conversation thread
- **WHEN** a chat turn is prepared
- **THEN** the run-activity record lists the full run id of each running run, and it does not list the failed run
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

## REMOVED Requirements

### Requirement: Conversation turns store the fresh run activity of the running runs after the user message

**Reason**: Its scenarios of a suspension describe a state that no longer exists. A MODIFIED block cannot drop a scenario, thus the requirement "A turn stores the fresh run activity of the running runs after the user message" replaces it.

**Migration**: Refer to "A turn stores the fresh run activity of the running runs after the user message" in this capability.
