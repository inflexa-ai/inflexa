# analysis-input-management Delta

## MODIFIED Requirements

### Requirement: Manage analysis inputs after creation through the shared register-only operations

The system SHALL let inputs be added AND removed after analysis creation through the existing operations in `src/modules/analysis/analysis.ts` — `addInputs` (insert `analysis_inputs` rows, emit `prov.input_added`), `removeInput` (delete a row, emit `prov.input_removed`), and `applyInputsDiff` (a combined add-then-remove batch). These operations SHALL run in the local server process. The surfaces that share them are the input routes of the local server, and the conversation-agent tool that runs inside a chat turn in the server. The TUI file picker / "Manage inputs" flow and the `inflexa inputs add <paths…>` and `inflexa inputs remove <paths…>` subcommands call the input routes. No surface SHALL re-implement registration. A client SHALL resolve each relative path against its own working folder, and SHALL send absolute paths.

Input mutation SHALL be register-only: the operation SHALL NOT stage files into the workspace tree and SHALL NOT boot a harness runtime. Materialization SHALL remain owned by `input-staging` and re-profiling by the input-change watch of the local server.

The `inputs add`/`inputs remove` subcommands SHALL be agent-blocked (the conversation agent's `run_inflexa` tool may not invoke them): during a chat the agent changes the inputs with its own tool, which asks the user for approval inside the turn and records the change in the provenance of the turn. The subcommands are the terminal (human) surface; `inputs ls` remains agent-runnable (read-only).

#### Scenario: The subcommand registers an input without staging or booting

- **WHEN** `inflexa inputs add <path>` runs for a resolved analysis
- **THEN** the local server creates an `analysis_inputs` row for the absolute path and emits `prov.input_added`
- **AND** the mutation stages no file into the workspace tree, and the process of the subcommand boots no harness runtime

#### Scenario: The subcommand removes an input

- **WHEN** `inflexa inputs remove <path>` runs for a path that is a current input of the analysis
- **THEN** the local server deletes that `analysis_inputs` row and emits `prov.input_removed`

#### Scenario: The agent tool adds and removes in the chat's own process

- **WHEN** the agent tool adds and/or removes inputs during a live chat
- **THEN** it applies them via the same `addInputs`/`removeInput`/`applyInputsDiff` in the server process, which runs the chat turn
- **AND** the resulting `prov.input_added`/`prov.input_removed` are emitted on the bus of the server, which the running recorder and the input-change watch observe

#### Scenario: The agent adds and removes via the in-process tool, confirmation-gated

- **WHEN** the agent adds or removes inputs
- **THEN** it does so through its tool in the process of the turn (never the agent-blocked subcommand)
- **AND** the action is approval-gated so the user confirms before any input is added or removed

## REMOVED Requirements

### Requirement: Added or removed inputs re-profile through the parity engine, not the mutation path

**Reason**: The re-profile after an input change moved into the local server. It watches the input events of each writer in its process, thus a change of a terminal subcommand re-profiles at once, not at the next open.
**Migration**: The requirement "Added or removed inputs re-profile through the input-change watch of the local server" gives the re-profile behavior.

## ADDED Requirements

### Requirement: Added or removed inputs re-profile through the input-change watch of the local server

Adding or removing an input SHALL NOT itself trigger data profiling. The local server SHALL watch the input events of each writer in its process — an input route, or the agent's input tool inside a turn. After a short debounce for each analysis, it SHALL queue one re-profile drive behind the profile work of that analysis. The drive needs the runtime: a change whose debounce ends before the runtime is ready drives no re-profile. Emptying the input set SHALL clear the now-stale profile through the same drive. A client SHALL NOT re-profile after its own input change.

#### Scenario: A mid-chat mutation reprofiles in the server

- **GIVEN** an open chat on an analysis
- **WHEN** the agent adds or removes an input inside a turn
- **THEN** the mutation triggers no profiling directly
- **AND** the input-change watch of the server starts a re-profile (or clears the profile if the set emptied) after its debounce

#### Scenario: A terminal mutation reprofiles in the server

- **GIVEN** a local server whose runtime is ready, and no open chat on the analysis
- **WHEN** `inflexa inputs add` or `inflexa inputs remove` changes the input set
- **THEN** no profiling runs inside the route
- **AND** the input-change watch of the server re-profiles the analysis after its debounce

#### Scenario: A burst of changes gets one re-profile

- **WHEN** a batch edit changes several inputs of one analysis inside the debounce window
- **THEN** the server queues one re-profile drive for that analysis
