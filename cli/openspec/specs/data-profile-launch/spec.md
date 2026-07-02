# data-profile-launch Specification

## Purpose
`inflexa profile` — the one deliberate action that stages an analysis's inputs, boots the embedded harness, seeds the ledger, triggers the data-profile workflow, and narrates the run to a terminal state (`--status` reads the ledger without booting anything). Deliberate-only per the no-litter policy: no passive flow may stage files or boot the runtime.
## Requirements

### Requirement: Data-profile launch is a deliberate action

The system SHALL provide a dedicated text command that runs a data profile for a
resolved analysis. Only this action (and no passive flow) SHALL stage files, boot the
harness runtime, or trigger workflows. Bare `inflexa`, `inflexa new`/`resume`, and TUI
startup SHALL remain free of staging writes and runtime boots.

#### Scenario: Passive launch stays side-effect free

- **WHEN** the user runs bare `inflexa` on an analysis that has never been profiled
- **THEN** no session tree is created, no files are staged, and DBOS is not launched

#### Scenario: The command performs the run

- **WHEN** the user invokes the profile command for an analysis with staged-able inputs
- **THEN** inputs are staged, the runtime is booted (if needed), and the data-profile workflow is triggered

### Requirement: Staging precedes the trigger and the manifest rides verbatim

The command SHALL stage the analysis's inputs into the session tree before triggering,
and SHALL pass the resulting manifest to the trigger unchanged. The trigger SHALL be
invoked with a local auth context and the analysis's cli id as the harness
`analysisId` (the ids must be identical — harness records key on it).

#### Scenario: Trigger receives exactly what staging produced

- **WHEN** staging returns a manifest of N entries
- **THEN** the workflow input carries those N entries unmodified and the harness reads each staged file at its manifest path

#### Scenario: Analysis with no resolvable inputs does not trigger

- **WHEN** staging produces an empty manifest
- **THEN** the command reports why (no resolvable inputs) and does not trigger the workflow

### Requirement: Trigger outcomes are surfaced distinctly

The command SHALL map each trigger outcome — started, restarted, already running,
failed — to a distinct user-facing message. A failed trigger SHALL surface the
underlying reason, never a silent exit.

#### Scenario: Concurrent second launch

- **WHEN** the command is invoked while a profile for the same analysis is running
- **THEN** the user is told a run is already in progress and no duplicate workflow starts

### Requirement: Missing prerequisites yield actionable errors

The command SHALL fail with an error that names the missing prerequisite and its
remedial action whenever a prerequisite is unavailable. Covered prerequisites:
Postgres not provisioned or not running (remedy: the setup flow), the sandbox image
absent (remedy: build or pull the image), the local proxy unreachable (remedy: start
or configure the proxy), the embedding endpoint unconfigured or unreachable (remedy:
set the embedding config key — its own baseURL + API key, separate from the chat
proxy; the profile's vector indexing cannot run without one and would fail after the
sandbox run already spent its work). Raw connection errors SHALL NOT be the surfaced
form. Prerequisite checks SHALL run before staging and triggering.

#### Scenario: Unprovisioned Postgres

- **WHEN** the profile command runs before setup has provisioned Postgres
- **THEN** the error names Postgres and points at the setup flow

#### Scenario: Missing sandbox image

- **WHEN** the Docker daemon has no sandbox-base image
- **THEN** the error names the image and how to obtain it

#### Scenario: Unconfigured or unreachable embedding endpoint blocks before any work

- **WHEN** the profile command runs with no embedding endpoint configured, or with one that does not answer embeddings requests
- **THEN** the command fails naming the config key (and the endpoint, when probing failed) before staging or triggering anything

### Requirement: The command narrates progress and exits at the terminal state

While waiting for the run, the command SHALL show live progress (at minimum the
current workflow step translated to a human label, plus elapsed time), sourced
best-effort from the durable step record — a progress-read failure SHALL never abort
the wait. When the run reaches a terminal state the command SHALL report it and exit
on its own, draining the runtime (DBOS shutdown, listener close, pool end) — the
runtime's live handles otherwise keep the process alive indefinitely.

#### Scenario: Completed run ends the command

- **WHEN** the profile reaches `completed` while the command is waiting
- **THEN** the command reports completion and the process exits without user input

#### Scenario: Progress reads never kill the wait

- **WHEN** a progress query against the step record fails mid-run
- **THEN** the wait continues and only the progress detail degrades

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
