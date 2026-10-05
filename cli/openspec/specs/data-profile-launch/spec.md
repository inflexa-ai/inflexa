# data-profile-launch Specification

## Purpose
`inflexa profile` — the one deliberate action that asks the local server to profile an analysis again: the server stages the inputs, seeds the ledger, and triggers the data-profile workflow, and the command follows the profile to a terminal state (`--status` reads the profile state of the server and starts nothing). Deliberate-only per the no-litter policy: no passive flow may stage files or boot the runtime.

## Requirements

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

### Requirement: Staging precedes the trigger and the manifest rides verbatim

Every path that dispatches a data-profile workflow SHALL stage the analysis's inputs into the session
data dir first, seed the ledger with the resulting manifest, and hand that manifest to the trigger
unchanged. The trigger SHALL be invoked with a local auth context and the analysis's cli id as the
harness `analysisId` (the ids must be identical — harness records key on it). Staging content-hashes
each file and mirrors the tree — deleting staged files no current input produces — so it SHALL run only
once a (re-)trigger has been decided, never as part of a parity comparison.

Because tree mirroring deletes any on-disk file absent from the manifest the *calling* staging run
built, and because the harness's ledger CAS serializes only the workflow dispatch that happens *after*
staging, staging for one analysis SHALL NOT run concurrently with itself. In the CLI's single-process
model the per-analysis instance lock excludes other processes (it is re-entrant per pid, so it cannot
serve this purpose in-process); the in-process callers SHALL serialize among themselves.

The same serialization SHALL cover the ledger clear that an emptied input set performs, because
clearing nulls `seed_input_file_ids` and would otherwise be able to land between a concurrent drive's
seed write and its trigger, causing that drive to be refused for an absent seed.

#### Scenario: Trigger receives exactly what staging produced

- **WHEN** staging returns a manifest of N entries
- **THEN** the workflow input carries those N entries unmodified, in order, and the harness reads each staged file at its manifest path

#### Scenario: Analysis with no resolvable inputs does not trigger

- **WHEN** staging produces an empty manifest
- **THEN** the command reports why (no resolvable inputs) and does not trigger the workflow

#### Scenario: Concurrent drives do not race the staged tree

- **WHEN** two profile drives for the same analysis are requested while the first is still staging
- **THEN** the second SHALL run only after the first has completed its stage → seed → trigger sequence
- **AND** no staged input file SHALL be deleted by a run that did not enumerate it

#### Scenario: A clear cannot refuse a concurrent seed

- **WHEN** a drive observing an empty input set clears the ledger while another drive has seeded a non-empty set but not yet triggered
- **THEN** the two SHALL NOT interleave, and the seeding drive SHALL NOT be refused for a missing seed

### Requirement: Trigger outcomes are surfaced distinctly

The command SHALL map each trigger outcome — started, restarted, already running,
failed — to a distinct user-facing message. A failed trigger SHALL surface the
underlying reason, never a silent exit.

#### Scenario: Concurrent second launch

- **WHEN** the command is invoked while a profile for the same analysis is running
- **THEN** the user is told a run is already in progress and no duplicate workflow starts

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

### Requirement: Profile run state is observable

The system SHALL let the user observe a triggered profile's state (at minimum:
running, completed, failed — including a run resumed by DBOS recovery from a previous
session) sourced from the harness ledger, so the fire-and-forget trigger is not a
black hole.

#### Scenario: Run completes after the trigger returns

- **WHEN** the user checks profile status after a completed run
- **THEN** the state reflects completion sourced from the harness ledger

#### Scenario: Recovered run is visible

- **WHEN** a previous session crashed mid-profile and the runtime has booted again
- **THEN** the resumed run's state is visible rather than appearing as a fresh or lost run

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

### Requirement: The headless checks re-profile on a recorded input mutation, not on a comparison

A re-profile SHALL be driven by an input mutation this process performed and recorded, never by
comparing a freshly enumerated input set against the one a completed row covered.

`reprofileForInputChange` SHALL be the entry point the in-process `prov.input_added` /
`prov.input_removed` edge drives. It SHALL (re-)trigger a `completed` row, and SHALL retry a `failed`
row rather than skipping it, because the set that failed is demonstrably not the set on disk now.

`ensureProfileAtParity` SHALL be the entry point a chat open, an analysis swap, and a settling profile
run drive. Against a `completed` row it SHALL bring the workspace tree up to date — consulting the
already-materialized predicate and staging when the tree is behind — and SHALL yield `already_profiled`
without dispatching a workflow. It SHALL NOT compare input sets, and SHALL NOT re-profile on any
difference it might have observed.

Both SHALL share the rest of the ladder: the orphaned-`running` reconcile, the emptied-set clear (an
emptied input set is an input mutation too), and the live-run defer, which suppresses materialization
because staging reconcile-deletes a tree that run's sandbox is reading.

The comparison is removed rather than narrowed because it was an inference standing in for a fact. A
`(fileId, size, mtimeMs)` difference is produced by `git checkout`, `cp -r`, `rsync` without `-a`,
unzip, and cloud sync without a byte changing, and each false positive costs a sandbox spin-up plus an
agent run whose output re-rolls the kind names, axis labels, and summary a user is already working from.

`forceReprofile` SHALL continue past a live-run check to always materialize, seed, and trigger. It is
also the only repair for an in-place edit of an already-attached file, which changes no path and so
raises no input event.

#### Scenario: A chat open does not re-profile a completed row

- **GIVEN** a `completed` profile row and an input set that no longer matches what it covered
- **WHEN** `ensureProfileAtParity` runs
- **THEN** it SHALL yield `already_profiled` and dispatch no workflow

#### Scenario: A chat open still brings the tree up to date

- **GIVEN** a `completed` profile row whose staged tree is behind the current input set
- **WHEN** `ensureProfileAtParity` runs
- **THEN** it SHALL stage the current input set
- **AND** SHALL still yield `already_profiled` without dispatching a workflow

#### Scenario: An input mutation re-profiles

- **WHEN** `reprofileForInputChange` runs against a `completed` row
- **THEN** it SHALL materialize, seed, and trigger, yielding `triggered`

#### Scenario: An input mutation retries a failed row

- **GIVEN** a `failed` row whose input set is already materialized
- **WHEN** `reprofileForInputChange` runs
- **THEN** it SHALL claim the `failed → running` transition and run, rather than yielding `skipped_failed`

#### Scenario: An emptied input set clears on either drive

- **GIVEN** an analysis whose inputs have all been removed
- **WHEN** either entry point runs against a settled profile row
- **THEN** the profile SHALL be cleared and the outcome SHALL be `cleared`

#### Scenario: A live run defers both drives

- **GIVEN** a `running` profile row
- **WHEN** either entry point runs
- **THEN** it SHALL yield `already_running` and SHALL NOT stage
