# data-profile-launch Specification

## Purpose
`inflexa profile` — the one deliberate action that stages an analysis's inputs, boots the embedded harness, seeds the ledger, triggers the data-profile workflow, and narrates the run to a terminal state (`--status` reads the ledger without booting anything). Deliberate-only per the no-litter policy: no passive flow may stage files or boot the runtime.
## Requirements

### Requirement: Data-profile launch is a deliberate action

The system SHALL provide a dedicated text command that runs a data profile for a resolved analysis.
Staging files, booting the harness runtime, and triggering workflows SHALL happen only on deliberate
actions: this command, the run/chat commands, opening an analysis chat in the TUI, mutating an
analysis's inputs while the TUI's runtime is ready, and the TUI's manual re-profile action — the TUI
edges keep the profile at managed parity with the current input set (drift re-trigger, clear on an
emptied set; see `tui-harness-chat`). Parity *checks* on these edges SHALL be read-only (the
identity-only enumeration per `input-staging`); staging writes happen only when a (re-)trigger
actually fires. Flows that resolve to no analysis chat — bare `inflexa` resolving to nothing, the
welcome screen, `--status` views, `inflexa ls`/`status` — SHALL remain free of staging writes and
runtime boots.

#### Scenario: No-analysis flows stay side-effect free

- **WHEN** the user runs bare `inflexa` and it resolves to no analysis (welcome/no-op path)
- **THEN** no session tree is created, no files are staged, and DBOS is not launched

#### Scenario: Opening an analysis chat is a deliberate profile trigger

- **WHEN** the TUI opens an analysis chat for an analysis whose profile is missing or drifted from the current input set
- **THEN** the same stage → seed → trigger sequence runs (non-blocking), per `tui-harness-chat`

#### Scenario: A no-drift check stages nothing

- **WHEN** a parity edge fires for an analysis whose completed profile matches the current input set
- **THEN** no staging write occurs and no workflow is triggered

#### Scenario: The command performs the run

- **WHEN** the user invokes the profile command for an analysis with staged-able inputs
- **THEN** inputs are staged, the runtime is booted (if needed), and the data-profile workflow is triggered

### Requirement: The headless parity and force checks judge drift on content signatures

`ensureProfileAtParity` SHALL compare the analysis's freshly enumerated **drift signatures** —
`(fileId, size, mtimeMs)` per input file, from `enumerateInputSignatures` — against the signatures a
completed ledger row recorded (`result.inputFiles`). A completed row whose recorded signature set
equals the current one SHALL yield `already_profiled`; any difference, in either direction, SHALL
(re-)trigger.

A completed row that records **no** signatures — a `null` result, or a result written before the
signature field existed — SHALL be treated as drifted and re-profiled, rather than trusted. This is the
same self-heal the check already applies to a null result: re-profiling repairs the contract gap and
costs one run.

`forceReprofile` SHALL continue to skip the drift comparison entirely; it reads the signature set only
to decide whether the input set is empty.

#### Scenario: An in-place content edit is drift

- **WHEN** an input file's bytes change at the same path and `ensureProfileAtParity` runs against a completed row
- **THEN** the current signature set SHALL differ from the recorded one and the check SHALL trigger a re-profile

#### Scenario: An unchanged input set is at parity

- **WHEN** no input file has been added, removed, or modified since the completed profile
- **THEN** the check SHALL yield `already_profiled` and no workflow SHALL be dispatched

#### Scenario: A signature-less completed row re-profiles

- **WHEN** the completed row's `result` carries `inputFileIds` but no `inputFiles`
- **THEN** the check SHALL treat it as drifted and trigger

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

The command SHALL fail with an error that names the missing prerequisite and its
remedial action whenever a prerequisite is unavailable. Covered prerequisites:
Postgres not provisioned or not running (remedy: the setup flow), the sandbox image
absent (remedy: build or pull the image), the local proxy unreachable (remedy: start
or configure the proxy), the embedder unresolved or failing its boot probe (remedy:
`inflexa setup --embeddings`, or the top-level `embedding` config key — api-key mode
connects directly to an OpenAI-compatible endpoint, separate from the chat proxy; the
profile's vector indexing cannot run without an embedder and would fail after the
sandbox run already spent its work). Raw connection errors SHALL NOT be the surfaced
form. Prerequisite checks SHALL run before staging and triggering.

#### Scenario: Unprovisioned Postgres

- **WHEN** the profile command runs before setup has provisioned Postgres
- **THEN** the error names Postgres and points at the setup flow

#### Scenario: Missing sandbox image

- **WHEN** the Docker daemon has no sandbox-base image
- **THEN** the error names the image and how to obtain it

#### Scenario: Unconfigured or broken embedder blocks before any work

- **WHEN** the profile command runs with `embedding.mode = "off"`, an incomplete embedding config, or an embedder that fails its probe embedding
- **THEN** the command fails naming the `embedding` config key and the remedial setup command before staging or triggering anything

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
