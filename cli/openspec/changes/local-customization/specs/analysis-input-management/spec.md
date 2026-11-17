## MODIFIED Requirements

### Requirement: Manage analysis inputs after creation through the shared register-only operations

The system SHALL let inputs be added AND removed after analysis creation through the existing operations in `src/modules/analysis/analysis.ts` — `addInputs` (insert `analysis_inputs` rows, emit `prov.input_added`), `removeInput` (delete a row, emit `prov.input_removed`), and `applyInputsDiff` (a combined add-then-remove batch). These operations SHALL run in the local server process. The surfaces that share them are the input routes of the local server, and the conversation-agent tool that runs inside a chat turn in the server. The TUI file picker / "Manage inputs" flow and the `inflexa inputs add <paths…>` and `inflexa inputs remove <paths…>` subcommands call the input routes. No surface SHALL re-implement registration. A client SHALL resolve each relative path against its own working folder, and SHALL send absolute paths.

Input mutation SHALL be register-only: the operation SHALL NOT stage files into the workspace tree and SHALL NOT boot a harness runtime. Materialization SHALL remain owned by `input-staging` and re-profiling by the input-change watch of the local server.

The `inputs add`/`inputs remove` subcommands SHALL be agent-blocked (the conversation agent's `run_inflexa` tool may not invoke them): during a chat the agent changes the inputs with its own tool, which asks the user for approval inside the turn for a path outside the anchor folder of the analysis and records the change in the provenance of the turn. The subcommands are the terminal (human) surface; `inputs ls` remains agent-runnable (read-only).

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
- **AND** the action is approval-gated so the user confirms before any input is added or removed, except an add of paths that all resolve inside the anchor folder of the analysis

#### Scenario: The agent adds a file of the anchor folder with no approval

- **GIVEN** a file that a GEO download wrote into the anchor folder of the analysis
- **WHEN** the agent adds it as an input
- **THEN** the tool adds it with no approval, and a path whose link resolves outside the anchor folder still asks
