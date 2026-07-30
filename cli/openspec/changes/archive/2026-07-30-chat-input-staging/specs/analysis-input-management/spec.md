## ADDED Requirements

### Requirement: Manage analysis inputs after creation through the shared register-only operations

The system SHALL let inputs be added AND removed after analysis creation through the existing operations in `src/modules/analysis/analysis.ts` — `addInputs` (insert `analysis_inputs` rows, emit `prov.input_added`), `removeInput` (delete a row, emit `prov.input_removed`), and `applyInputsDiff` (a combined add-then-remove batch) — from surfaces sharing those operations: the TUI file picker / "Manage inputs" flow (existing), new `inflexa inputs add <paths…>` and `inflexa inputs remove <paths…>` subcommands, and a new in-process conversation-agent tool that can add and remove. No surface SHALL re-implement registration.

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

### Requirement: Adding an input rejects paths that do not exist

The add path SHALL verify that each supplied path exists on disk before storing a reference, reusing the existing `classifyInputPath` stat check so a hallucinated or mistyped path (e.g. an agent adding `foo.csv` a user merely named) is rejected rather than stored as a dangling input. When any supplied path does not exist, the whole add SHALL be rejected — no partial registration — and the surface SHALL return a clear message identifying the offending path as not found (distinct from a genuine I/O fault), so the agent can correct the path rather than treating it as a system error.

#### Scenario: A non-existent path is rejected before any row is written

- **WHEN** `inflexa inputs add ./foo.csv` runs and `foo.csv` does not exist under the resolved directory
- **THEN** no `analysis_inputs` row is created and no `prov.input_added` is emitted
- **AND** the command reports that `foo.csv` was not found

#### Scenario: One bad path rejects the whole batch

- **WHEN** an add supplies one existing path and one non-existent path
- **THEN** neither path is registered (the add is all-or-nothing) and the response names the non-existent path

### Requirement: Removing an input resolves against the registered set, not the filesystem

Removing an input SHALL identify the target by matching the supplied reference against the analysis's currently registered inputs — NOT by requiring the underlying file to still exist — so an input whose file was moved or deleted can still be removed. A supplied reference that matches no current input SHALL be reported as "not a current input" (a no-op), never as a filesystem error.

#### Scenario: An input whose file is gone can still be removed

- **GIVEN** a registered input whose underlying file has since been deleted from disk
- **WHEN** `inflexa inputs remove <that path>` runs
- **THEN** the input row is deleted and `prov.input_removed` is emitted, without any on-disk existence check

#### Scenario: Removing a path that is not an input is a reported no-op

- **WHEN** a remove targets a path that matches no current `analysis_inputs` row
- **THEN** nothing is deleted and the surface reports that the path is not a current input

### Requirement: The agent can enumerate the analysis's current inputs

The system SHALL provide the conversation agent a read-only way to list the analysis's currently registered inputs (their stored references), so the agent can choose what to remove and can report the current input set. This complements the launch-dir listing (candidate files on disk) with the registered set (which may include inputs outside the anchor folder).

#### Scenario: Listing returns the registered inputs

- **WHEN** the agent requests the analysis's current inputs
- **THEN** it receives the set of registered `analysis_inputs` references, including inputs whose paths are outside the anchor folder

### Requirement: Added or removed inputs re-profile through the parity engine, not the mutation path

Adding or removing an input SHALL NOT itself trigger data profiling. The mutation changes the analysis's current input set, and the existing profile-parity engine SHALL detect the drift and re-profile: immediately on a running chat (its in-process input-mutation edge), or on the next open of the analysis otherwise. Emptying the input set SHALL clear the now-stale profile through the same engine.

#### Scenario: A mid-chat mutation reprofiles immediately

- **GIVEN** an open chat on an analysis
- **WHEN** the agent adds or removes an input in-process
- **THEN** the mutation triggers no profiling directly
- **AND** the profile-parity engine observes the input-set drift and starts a re-profile (or clears the profile if the set emptied) in the running process

#### Scenario: A terminal mutation reprofiles on next open

- **GIVEN** no live instance holds the analysis
- **WHEN** `inflexa inputs add` or `inflexa inputs remove` changes the input set
- **THEN** no profiling runs at mutation time
- **AND** the next open of that analysis detects the drift and re-profiles
