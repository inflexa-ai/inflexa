## ADDED Requirements

### Requirement: The compaction part maps live and on reload

The conversation store MUST map the harness `data-compaction` part to a compaction part in the live emit reducer (`applyEmitEvent`) and in the reload path (`cortexToUiMessage`). Both paths MUST use one shared reader.

The reader MUST copy each field that it keeps: the id of the compaction, the status, the tokens before and after, and the duration. An unknown or missing status MUST read as `failed`, the safe terminal. Thus a malformed emission never leaves a live line with no terminal status.

Live, the first emission of an id MUST append a compaction part to the assistant message of the turn. A later emission with the same id MUST replace the status and the figures of that part in place. It MUST NOT append a second part.

After a reload, the harness gives each stored marker as a `system` message with one `data-compaction` part at its final status. The store MUST map that message to an event entry with one compaction part. The event entry is not a turn, and it is not retractable.

#### Scenario: Live emissions update one part

- **GIVEN** a turn whose root loop compacts
- **WHEN** the harness emits the part with `running`, and then with `done` under the same id
- **THEN** the assistant message of the turn holds one compaction part, with the status `done` and the figures of the second emission

#### Scenario: A reload gives the divider as an event entry

- **GIVEN** a stored turn whose compaction ended with a summary marker
- **WHEN** the thread reloads from pg
- **THEN** the transcript holds an event entry with one compaction part at the status `done`, between the two assistant messages of the turn

#### Scenario: A malformed status is a terminal failure

- **WHEN** the harness emits a `data-compaction` part whose status the reader does not know
- **THEN** the compaction part carries the status `failed`

#### Scenario: The part is not a tagged mention

- **WHEN** the harness emits a `data-compaction` part, live or in a reloaded thread
- **THEN** the transcript shows no tagged mention of the part
