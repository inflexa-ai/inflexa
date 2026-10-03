# analysis-input-management Specification

## Purpose

Define provenance-safe add AND remove of analysis inputs after creation. Every surface — the TUI file picker, the `inflexa inputs add`/`inputs remove` subcommands, and the in-process conversation-agent tool — goes through the shared `addInputs`/`removeInput`/`applyInputsDiff` operations. Mutation is register-only: it stages nothing and boots no runtime, leaving materialization to `input-staging` and re-profiling to the input-change watch of the local server. Adds are existence-checked and all-or-nothing; removes resolve against the registered set rather than the filesystem.

## Requirements

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

### Requirement: Adding an input rejects paths that do not exist

The add path SHALL verify that each supplied path exists on disk before storing a reference, reusing the existing `classifyInputPath` stat check so a hallucinated or mistyped path (e.g. an agent adding `foo.csv` a user merely named) is rejected rather than stored as a dangling input. When any supplied path does not exist, the whole add SHALL be rejected — no partial registration — and the surface SHALL return a clear message identifying the offending path as not found (distinct from a genuine I/O fault), so the agent can correct the path rather than treating it as a system error.

#### Scenario: A non-existent path is rejected before any row is written

- **WHEN** `inflexa inputs add ./foo.csv` runs and `foo.csv` does not exist under the resolved directory
- **THEN** no `analysis_inputs` row is created and no `prov.input_added` is emitted
- **AND** the command reports that `foo.csv` was not found

#### Scenario: One bad path rejects the whole batch

- **WHEN** an add supplies one existing path and one non-existent path
- **THEN** neither path is registered (the add is all-or-nothing) and the response names the non-existent path

### Requirement: A marker that the database does not hold recovers its anchor row

The add path MUST make sure that the anchor row of a found marker exists before it stores an anchored reference. A marker can name an anchor that the database does not hold. A replaced database, and a folder authored on a different machine, both make that state. The add MUST then insert the row again, keyed on the UUID of the marker, through the shared `getOrCreateAnchorForCwd`. The stored reference MUST carry the id of the recovered row. The add MUST NOT fail on the anchor foreign key, and it MUST NOT degrade the reference to an absolute path. The marker is the identity of the folder, thus the recovery keeps it.

An `inputs add` is a deliberate user action, thus the recovery obeys the no-litter policy. The marker-present branch of the recovery writes nothing to disk.

#### Scenario: A stale marker does not fail the add

- **WHEN** `inflexa inputs add <path>` runs for a file inside a folder whose marker names an anchor the database does not hold
- **THEN** the anchor row is inserted again with the UUID of the marker
- **AND** the input registers as an anchor-relative reference under that anchor

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

### Requirement: manage_inputs describes its call by action and target

`manage_inputs` SHALL declare a `describeCall` hook naming the action the call performs and what it acts on. An `add` or `remove` call SHALL name the paths it carries, and SHALL report a count rather than an enumeration when it carries enough of them that naming each would exceed what one line can usefully hold. A `list` call carries no paths and SHALL be described by its action alone.

The `paths` field is optional in the schema and required only for `add` and `remove`, so the hook SHALL tolerate its absence rather than assuming it.

#### Scenario: A single-path add names the file

- **GIVEN** an `add` call carrying one path
- **WHEN** the tool call is rendered
- **THEN** the detail names the action and that path

#### Scenario: A multi-path remove reports what it acts on

- **GIVEN** a `remove` call carrying several paths
- **WHEN** the tool call is rendered
- **THEN** the detail names the action and identifies the paths, without emitting an unbounded enumeration

#### Scenario: A list call is described by its action

- **GIVEN** a `list` call, which carries no paths
- **WHEN** the tool call is rendered
- **THEN** the detail names the action and does not imply a target

#### Scenario: An add missing its paths still produces a detail

- **GIVEN** an `add` call whose `paths` field is absent, which the schema permits and `execute` rejects
- **WHEN** the tool call is rendered
- **THEN** the detail names the action rather than producing an empty string

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
