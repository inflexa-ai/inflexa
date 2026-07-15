# infra-state-resilience Specification

## Purpose
Local infra/provisioned state — proxy config, compose file, mount sources, and the Postgres substrate — must survive commands running in any order on any on-disk state. Each command provisions its own preconditions, heals what is safely healable, never destroys non-empty user state, never lets a container engine manufacture host state, and translates expected failures into named remediation.
## Requirements
### Requirement: Commands are order-independent and self-provisioning

Every infra/provisioning command (`setup`, `up`, the launch-time gates, `sandbox pull`, `profile`) SHALL validate and provision its own preconditions rather than assuming any other command ran first. No sequence of commands, executed in any order against any on-disk state — including state the user deleted or half-created and state a container engine manufactured — SHALL produce a state that no product command can recover from.

#### Scenario: `up` before `setup` on a fresh machine

- **WHEN** `inflexa up` runs on a machine where `inflexa setup` has never run and the data dir is absent
- **THEN** the command provisions what it needs (config, compose file, mount sources) and starts the stack, and a subsequent `inflexa setup` completes normally

#### Scenario: Any command after a user clears the data dir

- **WHEN** the user deletes the inflexa data dir and then runs any infra command
- **THEN** the command either converges to a working state or fails with an error naming the exact remediation — it never leaves state behind that wedges a later command

### Requirement: Mount-source integrity before compose

Before any `compose up`, the system SHALL ensure every bind-mount source in the compose plan exists on the host with the correct type — file-typed sources exist as files (provisioned with their canonical content when absent), directory-typed sources exist as directories. The container engine SHALL never be the creator of a mount source. The integrity check SHALL live at one shared seam through which every compose entry point passes, and the mount manifest SHALL derive from the same facts that generate the compose file. Every compose entry point SHALL regenerate the compose file from the current configuration before invoking the seam — the file the engine executes and the manifest the guard provisions SHALL always derive from the same facts in the same invocation, so a compose file written under an earlier configuration can never out-drift the guard. One-off container invocations outside compose that bind-mount a file-typed host path (e.g. the provider-login container) SHALL provision their mount sources through the same seam before the engine is invoked.

#### Scenario: Missing file-typed source is provisioned, not manufactured

- **WHEN** a compose entry point runs while the proxy config file is absent (cliproxy mode)
- **THEN** the proxy config file is written before the engine is invoked, and no directory is ever created at the file's path

#### Scenario: Missing directory-typed sources are created

- **WHEN** a compose entry point runs while the auth or postgres data directories are absent
- **THEN** they are created as directories before the engine is invoked

#### Scenario: Manifest covers every bind mount

- **WHEN** the compose file is generated for any connection mode
- **THEN** every bind-mount source in the generated file is covered by the integrity manifest for that mode

#### Scenario: Stale compose file cannot out-drift the guard

- **WHEN** the connection mode in config has changed since the on-disk compose file was generated and any compose entry point runs
- **THEN** the compose file is regenerated for the current mode before the guard runs, and the engine executes a file whose every mount source the guard just provisioned

#### Scenario: One-off container runs are guarded

- **WHEN** the provider-login container starts while the proxy config file is absent or occupied by an engine-manufactured empty directory
- **THEN** the source is provisioned or healed through the shared seam before the engine is invoked, and the engine never creates it

### Requirement: Safe healing of manufactured state

When a file-typed mount source is found to be an **empty directory** (the engine-manufactured artifact), the system SHALL remove the empty directory and provision the file in its place. Removal SHALL use a primitive that cannot delete a non-empty directory. When the occupying entry is anything else (a non-empty directory, or an entry the system cannot classify), the system SHALL NOT delete or overwrite it: it SHALL fail with an error naming the exact path, what was expected there, and the remediation. The CLI SHALL never recursively delete state it did not create in the same operation.

#### Scenario: Engine-manufactured directory is healed

- **WHEN** `inflexa setup` (or any compose entry point) finds an empty directory at the proxy config file's path
- **THEN** the empty directory is removed, the config file is written, and the command proceeds normally

#### Scenario: Non-empty occupying state is preserved

- **WHEN** a non-empty directory occupies the proxy config file's path
- **THEN** the command fails with an error naming that path and the expected file, instructs the user how to resolve it, and deletes nothing

### Requirement: Offered choices are achievable in the install context

Setup and other interactive flows SHALL NOT offer an option that cannot succeed in the current install context (e.g. a capability whose runtime is absent from the compiled binary). An unavailable option SHALL either be omitted or shown as unavailable with the reason and the available alternatives. When an unavailable option is requested explicitly (a CLI flag), the command SHALL fail with the reason and a named alternative **before** performing any resource-consuming work (downloads, container pulls) toward the doomed path.

#### Scenario: Unavailable mode is not offered interactively

- **WHEN** interactive setup runs in an install context where an offered capability cannot work
- **THEN** the picker omits it or marks it unavailable with the reason, and the remaining options are selectable

#### Scenario: Explicit flag for an unavailable mode fails before any download

- **WHEN** a CLI flag explicitly requests a capability that cannot work in the current install context
- **THEN** the command fails immediately with the reason and a named alternative, and no download or provisioning toward that capability occurs

### Requirement: Expected failures carry named remediation

Failures with a diagnosable cause SHALL travel the `Result` error channel with a typed cause and SHALL be rendered to the user as the specific problem plus the exact command or action that fixes it. Raw operating-system error text (e.g. `EISDIR`, `EACCES`) SHALL only reach the user through last-resort backstops for genuinely unanticipated failures — a known-cause state surfacing as "failed unexpectedly" is a defect. When a diagnosis describes an occupying filesystem entry, it SHALL name what the occupant actually is (a non-empty directory, a symlink, another non-file entry) rather than assuming one kind.

#### Scenario: Diagnosable filesystem state is translated

- **WHEN** provisioning encounters a known-cause filesystem state (e.g. an occupied config path)
- **THEN** the user sees the specific diagnosis and remediation, not a raw errno message

#### Scenario: Occupant kind is named

- **WHEN** a symlink (or other non-directory entry) occupies the proxy config file's path
- **THEN** the failure names the path and describes the occupant as what it is — never with prose that only fits a directory — and deletes nothing

#### Scenario: Unknown errors still reach the backstop

- **WHEN** provisioning fails for a cause the system has no diagnosis for
- **THEN** the backstop reports the underlying error rather than swallowing it

### Requirement: Idempotent convergence

Re-running any infra/provisioning command from any partial state — interrupted setup, half-provisioned stack, previously healed damage — SHALL converge to the same working state as a first clean run, without error and without duplicating state.

#### Scenario: Re-running setup after an interrupted run

- **WHEN** a previous `inflexa setup` was interrupted partway and `inflexa setup` runs again
- **THEN** the second run completes normally, reusing the state the first run already provisioned

#### Scenario: Repeated `up` is a no-op on a running stack

- **WHEN** `inflexa up` runs while the stack is already provisioned and running
- **THEN** the command succeeds without re-creating or restarting anything

