## MODIFIED Requirements

### Requirement: Display-card parts map live and on reload

The conversation store MUST keep each harness part as the harness gives it, in the live path and in the reload path. In the live path, `applyEmitEvent` applies each event of the top-level agent with `toChatFrame` and `applyChatFrame` of the harness. In the reload path, `loadMessages` mounts the messages of `storedMessagesToChat` with no change.

The live path MUST check each data part at receipt with `checkChatPart` of the harness. It MUST drop a part that the check refuses, and log the type of the part and the error. It MUST copy each part that it keeps, thus the store keeps no object that the agent loop can change.

The message renderer MUST read each card through its harness part type. `readPlanCard`, `readPresentation`, and `readFileReference` map a part to its view, thus a reloaded transcript renders the same cards as the live turn. A text-shaped presentation (`markdown`, `code`, `table`) MUST render as an inline presentation. An `echart` or `svg` presentation and a file reference MUST render as an openable card that holds only the semantic references. An unknown `data-*` part MUST keep the one-line tagged mention.

#### Scenario: Live and reloaded turns render alike

- **GIVEN** a turn where the agent emitted a markdown presentation and a file-reference gallery
- **WHEN** the user closes the session and the thread reloads from pg
- **THEN** the reloaded transcript shows the same inline markdown block and the same openable gallery card as the live turn

#### Scenario: Unknown parts still surface

- **WHEN** the harness emits a `data-*` part that the CLI has no renderer for
- **THEN** the transcript shows the one-line tagged mention of the part, and it does not drop the part

#### Scenario: A part that its schema refuses is dropped

- **WHEN** the harness emits a known `data-*` part that its schema refuses
- **THEN** the transcript does not show the part, and the log holds a warning with the type of the part

### Requirement: The compaction part maps live and on reload

The conversation store MUST keep the harness `data-compaction` part as the harness gives it, in the live path and in the reload path.

Live, `applyChatFrame` of the harness appends the first emission of an id to the assistant message of the turn. A later emission with the same id MUST replace the status and the figures of that part in place. It MUST NOT append a second part.

After a reload, the harness gives each stored marker as a `system` message with one `data-compaction` part at its final status. The store MUST mount that message with no change, and it renders as an event entry. The event entry is not a turn, and it is not retractable.

The message renderer MUST read the fields of the harness part directly. A part with a status that the harness schema does not know never reaches the store: the live path drops it at receipt, and the replay reads only parts that the harness checked when it stored them.

#### Scenario: Live emissions update one part

- **GIVEN** a turn whose root loop compacts
- **WHEN** the harness emits the part with `running`, and then with `done` under the same id
- **THEN** the assistant message of the turn holds one compaction part, with the status `done` and the figures of the second emission

#### Scenario: A reload gives the divider as an event entry

- **GIVEN** a stored turn whose compaction ended with a summary marker
- **WHEN** the thread reloads from pg
- **THEN** the transcript holds a `system` message with one compaction part at the status `done`, between the two assistant messages of the turn

#### Scenario: A malformed status is a terminal failure

- **WHEN** the harness emits a `data-compaction` part whose status the harness schema does not know
- **THEN** the live path drops the part at receipt, and no compaction line waits for a terminal status

#### Scenario: The part is not a tagged mention

- **WHEN** the harness emits a `data-compaction` part, live or in a reloaded thread
- **THEN** the transcript shows no tagged mention of the part
