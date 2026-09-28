## MODIFIED Requirements

### Requirement: Display-card parts map live and on reload

The conversation store MUST keep each harness part as the harness gives it, in the live path and in the reload path. In the live path, `applyEmitEvent` applies each event of the top-level agent with `toChatFrame` and `applyChatFrame` of the harness. In the reload path, `loadMessages` mounts the messages of `storedMessagesToCortex` with no change. The live path MUST copy each data part at receipt, thus the store keeps no object that the agent loop can change.

The message renderer MUST read each card through the shared readers of `chat_printer.ts` and `artifact_open.ts`. Thus a reloaded transcript renders the same cards as the live turn. A text-shaped presentation (`markdown`, `code`, `table`) MUST render as an inline presentation. An `echart` or `svg` presentation and a file reference MUST render as an openable card that holds only the semantic references. An unknown `data-*` part MUST keep the one-line tagged mention.

#### Scenario: Live and reloaded turns render alike

- **GIVEN** a turn where the agent emitted a markdown presentation and a file-reference gallery
- **WHEN** the user closes the session and the thread reloads from pg
- **THEN** the reloaded transcript shows the same inline markdown block and the same openable gallery card as the live turn

#### Scenario: Unknown parts still surface

- **WHEN** the harness emits a `data-*` part that the CLI has no renderer for
- **THEN** the transcript shows the one-line tagged mention of the part, and it does not drop the part
