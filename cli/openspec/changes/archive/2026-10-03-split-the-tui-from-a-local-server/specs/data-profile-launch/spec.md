# data-profile-launch Delta

## MODIFIED Requirements

### Requirement: Data-profile launch is a deliberate action

The system SHALL provide a dedicated text command that runs a data profile for a resolved analysis.
The command is a client of the local server: it asks the server for the deliberate re-profile, and the
server stages the inputs and triggers the workflow in its own runtime.

Staging files and triggering profile workflows SHALL happen only on deliberate actions, and only in a
process that runs the harness runtime: this command, `inflexa run --plan` (which stages in its own
process), the open of an analysis chat in the TUI (its chat-context read drives the parity check in the
server), an input change that the local server records from any writer (an input route, or the agent's
input tool inside a turn), and the TUI's manual re-profile action. The input-change edge is the
server's: it re-profiles after a short debounce, and only when its runtime is ready at the end of
that debounce. Parity *checks* on these
edges SHALL be read-only (the identity-only enumeration per `input-staging`); staging writes happen only
when a drive decides to materialize or to (re-)trigger.

The runtime boot SHALL belong to the local server, which boots at its own start. A flow that resolves to
no analysis chat — bare `inflexa` resolving to nothing, the welcome screen, `--status` views,
`inflexa ls`/`status` — SHALL remain free of staging writes and workflow triggers. Such a flow is a
client, and a client that finds no server starts one, thus the flow can start the local server and
with it the runtime.

#### Scenario: No-analysis flows stay side-effect free

- **WHEN** the user runs bare `inflexa` and it resolves to no analysis (welcome/no-op path)
- **THEN** no workspace tree is created, no files are staged, and no workflow is triggered

#### Scenario: A client that starts the server stages nothing

- **GIVEN** no local server runs
- **WHEN** the user runs `inflexa ls`
- **THEN** the command starts the local server, whose start boots the runtime
- **AND** no file is staged and no workflow is triggered

#### Scenario: Opening an analysis chat is a deliberate profile trigger

- **WHEN** the TUI opens an analysis chat for an analysis that was never profiled
- **THEN** the local server runs the stage → seed → trigger sequence for it (non-blocking), per `tui-harness-chat`

#### Scenario: A no-drift check stages nothing

- **WHEN** a parity edge fires for an analysis whose completed profile matches the current input set
- **THEN** no staging write occurs and no workflow is triggered

#### Scenario: The command performs the run

- **WHEN** the user invokes the profile command for an analysis with staged-able inputs
- **THEN** the local server stages the inputs and triggers the data-profile workflow in its runtime

### Requirement: Missing prerequisites yield actionable errors

The command SHALL fail with an error that names the missing prerequisite and its
remedial action whenever a prerequisite is unavailable. Raw connection errors SHALL
NOT be the surfaced form. Prerequisite checks SHALL run before staging and triggering.

The prerequisites of a sandbox are the command's own checks, from the sandbox
readiness read of the local server before it asks for the profile: the sandbox
image absent (remedy: `inflexa sandbox pull`, or build a custom image), the package
store absent or incomplete (remedy: `inflexa store download`), and a farm of the
analysis that could not be composed. An analysis with no inputs needs none of them.

The prerequisites of the runtime are the prerequisites of the boot of the local
server: Postgres not provisioned or not running (remedy: the setup flow), the local
proxy unreachable or not signed in (remedy: start or configure the proxy, or
`inflexa setup`), and the embedder unresolved or failing its boot probe (remedy:
`inflexa setup --embeddings`, or the top-level `embedding` config key — api-key mode
connects directly to an OpenAI-compatible endpoint, separate from the chat proxy; the
profile's vector indexing cannot run without an embedder and would fail after the
sandbox run already spent its work). The boot error of the server SHALL name such a
prerequisite and its remedy, and the server status, the TUI, and the server log
show it. While the runtime is not ready, the command SHALL refuse with the
unavailable answer of the server, before any staging or trigger.

#### Scenario: Unprovisioned Postgres

- **WHEN** the profile command runs before setup has provisioned Postgres
- **THEN** the boot error of the local server names Postgres and points at the setup flow
- **AND** the command refuses with the unavailable answer of the server, and nothing is staged

#### Scenario: Missing sandbox image

- **WHEN** the container engine has no sandbox-base image and the analysis has inputs
- **THEN** the error names the image and how to obtain it, before the command asks for the profile

#### Scenario: Unconfigured or broken embedder blocks before any work

- **WHEN** the local server boots with `embedding.mode = "off"`, an incomplete embedding config, or an embedder that fails its probe embedding
- **THEN** the boot error names the `embedding` config key and the remedial setup command, and the profile command refuses before staging or triggering anything

## REMOVED Requirements

### Requirement: The command narrates progress and exits at the terminal state

**Reason**: The profile runs in the runtime of the local server, not in the process of the command. The command reads the profile state of the server, thus it has no runtime to drain, and a failed read ends the wait instead of the profile.
**Migration**: The requirement "The command follows the profile of the local server to its terminal state" gives the wait behavior.

## ADDED Requirements

### Requirement: The command follows the profile of the local server to its terminal state

While waiting for the run, the command SHALL show live progress — at minimum the
profile state (waiting for the run to start, or profiling) plus the elapsed time —
from a read of the profile state of the local server at a fixed interval. When the
run reaches a terminal state the command SHALL report it and exit on its own.

The profile runs in the runtime of the local server, not in the process of the
command. Thus Ctrl+C, and a read of the profile state that fails, SHALL end only the
wait: the command SHALL exit with the reason, and the profile SHALL continue in the
server.

#### Scenario: Completed run ends the command

- **WHEN** the profile reaches `completed` while the command is waiting
- **THEN** the command reports completion and the process exits without user input

#### Scenario: A lost server ends only the wait

- **WHEN** a read of the profile state fails while the command is waiting
- **THEN** the command exits with the reason of the failed read
- **AND** the profile continues in the local server, and `inflexa profile --status` shows its state later
