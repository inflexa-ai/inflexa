## MODIFIED Requirements

### Requirement: Manage analysis inputs after creation through the shared register-only operations

The system SHALL let inputs be added AND removed after analysis creation through the existing operations in `src/modules/analysis/analysis.ts` — `addInputs` (insert `analysis_inputs` rows, emit `prov.input_added`), `removeInput` (delete a row, emit `prov.input_removed`), and `applyInputsDiff` (a combined add-then-remove batch) — from surfaces sharing those operations: the TUI file picker / "Manage inputs" flow (existing), new `inflexa inputs add <paths…>` and `inflexa inputs remove <paths…>` subcommands, and a new in-process conversation-agent tool that can add and remove. No surface SHALL re-implement registration.

The input-acquisition realization MUST be one more surface of `addInputs`.

`addInputs` MUST accept an optional acquisition callback. The callback gets
each inserted input, and it can give an acquisition ref. When it gives one,
`addInputs` MUST emit `prov.input_acquired` for that input, and then
`prov.input_added`. The two emits MUST occur in one synchronous span, thus
they land in one flush. A caller with no callback MUST get the current
behavior.

Input mutation SHALL be register-only: it SHALL NOT stage files into the workspace tree and SHALL NOT boot a harness runtime. Materialization SHALL remain owned by `input-staging` and re-profiling by the profile-parity engine.

The `inputs add`/`inputs remove` subcommands SHALL be agent-blocked (the conversation agent's `run_inflexa` tool may not invoke them): mid-chat mutation must run in-process via the agent tool so it writes provenance under the lock the chat already holds, and a subprocess would be refused by that lock. The subcommands are the terminal (human) surface; `inputs ls` remains agent-runnable (read-only).

#### Scenario: The subcommand registers an input without staging or booting

- **WHEN** `inflexa inputs add <path>` runs for a resolved analysis
- **THEN** an `analysis_inputs` row is created for the path and `prov.input_added` is emitted
- **AND** no file is staged into the workspace tree and no harness runtime is booted

#### Scenario: The subcommand removes an input

- **WHEN** `inflexa inputs remove <path>` runs for a path that is a current input of the analysis
- **THEN** that `analysis_inputs` row is deleted and `prov.input_removed` is emitted

#### Scenario: The agent tool adds and removes in the chat's own process

- **WHEN** the in-process agent tool adds and/or removes inputs during a live chat
- **THEN** it applies them via the same `addInputs`/`removeInput`/`applyInputsDiff` in the chat's process
- **AND** the resulting `prov.input_added`/`prov.input_removed` are emitted on the in-process bus the running recorder and profile-parity watcher observe

#### Scenario: The agent adds and removes via the in-process tool, confirmation-gated

- **WHEN** the agent adds or removes inputs
- **THEN** it does so through the in-process tool (never the agent-blocked subcommand)
- **AND** the action is approval-gated so the user confirms before any input is added or removed

#### Scenario: A downloaded input emits its origin first

- **WHEN** the input-acquisition realization calls `addInputs` with a
  callback that gives an acquisition ref
- **THEN** the bus receives `prov.input_acquired` and then `prov.input_added`
  for the new input, in one synchronous span

#### Scenario: A caller with no callback

- **WHEN** a surface calls `addInputs` with no callback
- **THEN** the bus receives `prov.input_added` only, as before this change
