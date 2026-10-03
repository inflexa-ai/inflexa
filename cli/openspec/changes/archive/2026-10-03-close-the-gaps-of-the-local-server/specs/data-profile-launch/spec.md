## MODIFIED Requirements

### Requirement: Data-profile launch is a deliberate action

The system MUST give a dedicated text command that runs a data profile for a resolved analysis. The command is a client of the local server. It asks the server for the deliberate re-profile, and the server stages the inputs and triggers the workflow in its own runtime.

A staging of files and a trigger of a profile workflow MUST occur only on a deliberate action. They MUST occur only in a process that runs the harness runtime. These are the deliberate actions:

- this command
- `inflexa run --plan`, which stages in its own process
- the open of an analysis chat in the TUI, whose chat-context read drives the parity check in the server
- an input change that the local server records from each writer: an input route, or the input tool of the agent inside a turn
- the manual re-profile action of the TUI

The input-change edge is the edge of the server. It re-profiles after a short debounce, when its runtime is ready and its sandbox gate passes. Until then the change waits, per `local-server`. The parity *checks* on these edges MUST be read-only: the enumeration of identities only, per `input-staging`. A staging write occurs only when a drive decides to materialize or to trigger again.

The runtime boot MUST belong to the local server, which boots at its own start. A flow that resolves to no analysis chat MUST stay free of staging writes and workflow triggers. Such flows are bare `inflexa` that resolves to nothing, the welcome screen, the `--status` views, and `inflexa ls` or `status`. Such a flow is a client, and a client that finds no server starts one. Thus the flow can start the local server and with it the runtime.

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

#### Scenario: An input change before the ready edge

- **GIVEN** a server whose runtime still boots
- **WHEN** a client adds an input to an analysis
- **THEN** the server runs the input-change drive at the first fire of its timer after the runtime is ready

### Requirement: Missing prerequisites yield actionable errors

The command MUST fail with an error that names the missing prerequisite and its remedy, each time a prerequisite is unavailable. A raw connection error MUST NOT be the form that the user sees. The checks of the prerequisites MUST run before the staging and the trigger.

The server checks the prerequisites of a sandbox before each profile drive, per `local-server`:

- no live transfer
- a sandbox image in the engine
- a package store that is present and complete
- no recorded failure of the farm composition of the analysis

The remedies are `inflexa sandbox pull` or the build of a custom image, and `inflexa store download`. A refusal gives 409 `conflict` with the line of the gate, and the command prints it. An analysis with no inputs needs none of them. The command itself does no check of the machine.

The prerequisites of the runtime are the prerequisites of the boot of the local server:

- Postgres that is not provisioned or does not run. The remedy is the setup flow.
- A local proxy that does not answer. The remedy is to start or configure the proxy.
- A provider login that is absent or dead. The remedy is `inflexa up` in a terminal.
- An embedder that does not resolve or fails its boot probe. The remedy is `inflexa setup --embeddings`, or the top-level `embedding` config key.

In api-key mode the embedder connects directly to an OpenAI-compatible endpoint, apart from the chat proxy. The vector index of the profile cannot run without an embedder, and it would fail after the sandbox run spent its work. The boot error of the server MUST name such a prerequisite and its remedy. The server status, the TUI, and the server log show it. While the runtime is not ready, the command MUST refuse with the unavailable answer of the server, before any staging or trigger.

#### Scenario: Unprovisioned Postgres

- **WHEN** the profile command runs before setup has provisioned Postgres
- **THEN** the boot error of the local server names Postgres and points at the setup flow
- **AND** the command refuses with the unavailable answer of the server, and nothing is staged

#### Scenario: Missing sandbox image

- **WHEN** the container engine has no sandbox-base image and the analysis has inputs
- **THEN** the server refuses the profile with 409 `conflict`, and the command prints the line that names the image and how to get it
- **AND** nothing is staged

#### Scenario: Unconfigured or broken embedder blocks before any work

- **WHEN** the local server boots with `embedding.mode = "off"`, an incomplete embedding config, or an embedder that fails its probe embedding
- **THEN** the boot error names the `embedding` config key and the remedial setup command
- **AND** the profile command refuses before staging or triggering anything
