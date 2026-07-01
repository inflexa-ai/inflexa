# data-profile-init Specification

## Purpose

Define the data-profile workflow — the per-analysis pass that characterizes the
input files so downstream planning has a real data context to reason over. The
workflow runs the `data-profiler` sandbox agent inside a DBOS-durable body, then
registers the input files as artifacts, indexes per-file descriptions into the
analysis vector store, and stores a result snapshot in the
`data_profile_status` ledger.

**Input materialization is the embedder's responsibility, not core's.** The
harness is a host-agnostic library whose every embedder wires its seams at a
composition root, and input staging differs by embedder — a hosted service
downloads from object storage; the CLI copies or links local files. Staging is
therefore a precondition the caller establishes *before* invoking core, not a
capability core invokes: the harness holds no stager and declares no staging
seam, and no core code calls stage. The workflow body assumes the
`data/inputs/` tree is already populated and profiles exactly the files in the
`StagedInput[]` manifest handed to it in `DataProfileWorkflowInput.stagedInputs`
— it never downloads. The manifest is JSON-serializable, rides in the DBOS
workflow input, and survives recovery; it carries the opaque source `fileId`
losslessly (a tree re-scan recovers paths and hashes but not the id that feeds
artifact registration and the re-profile staleness snapshot). Because inputs are
immutable and staged exactly once before the run starts, staging need not be a
durable step — a run recovered on another pod finds the tree already present. A
staging failure is a caller-side condition: the caller marks the profile failed
and never triggers the workflow, so nothing is authorized and nothing must be
revoked.

The agent delivers its result exclusively through a terminal `submit_profile`
tool, run via `runToTerminal` (see the harness-agent-loop spec); the tool input
is validated against `ProfilerOutputSchema`, so there is no message-text JSON
parsing. Sandbox resources are estimated per-run from the staged manifest rather
than fixed, and the dataset's `domain`/`subtype` are free-form strings, not a
fixed enum.

## Requirements

### Requirement: Core profiles an already-staged input tree

The workflow body SHALL assume the `data/inputs/` tree is already populated and
SHALL profile exactly the files in the `StagedInput[]` manifest carried in
`DataProfileWorkflowInput.stagedInputs`. The harness SHALL hold no stager and
declare no staging seam, and the body SHALL NOT download input files. When the
manifest is empty the body SHALL complete the profile as a no-op without starting
a sandbox.

#### Scenario: Body profiles the staged manifest without downloading

- **WHEN** the body runs with a non-empty `stagedInputs` manifest
- **THEN** it registers and profiles exactly those files and performs no download

#### Scenario: Empty manifest completes as a no-op

- **WHEN** the body runs with an empty `stagedInputs` manifest
- **THEN** it marks the profile completed, revokes the run authorization, and starts no sandbox

### Requirement: The data-profiler agent delivers results through a terminal submit_profile tool

The body SHALL run the `data-profiler` sandbox agent via `runToTerminal` (see the
harness-agent-loop spec) with a terminal `submit_profile` tool. The agent's
profiling result SHALL be delivered only through that tool, whose input SHALL be
validated against `ProfilerOutputSchema`; the body SHALL NOT parse result JSON
from the agent's message text. If the agent never calls `submit_profile` — even
after the salvage continuation — the body SHALL fail the profile.

#### Scenario: Agent submits its profile

- **WHEN** the data-profiler agent calls `submit_profile` with schema-valid metadata for every input file
- **THEN** the body records that profile and completes

#### Scenario: Agent never submits

- **WHEN** the agent reaches a terminal state without ever calling `submit_profile`, including the salvage continuation
- **THEN** the body fails the profile with an error and revokes the run authorization

### Requirement: Sandbox resources are estimated from the staged manifest

The body SHALL size the profiler sandbox via
`estimateDataProfileResources(stagedInputs)` — derived from file count, total
size, and per-format in-memory expansion — not a fixed spec. An empty manifest
SHALL estimate `{ cpu: 1, memoryGb: 2 }`.

#### Scenario: Larger inputs raise the estimate

- **WHEN** the manifest holds a multi-gigabyte file
- **THEN** the estimated `memoryGb` exceeds the 2 GiB floor

#### Scenario: Empty manifest uses the floor

- **WHEN** `estimateDataProfileResources` is called with an empty file list
- **THEN** it returns `{ cpu: 1, memoryGb: 2 }`

### Requirement: Dataset domain and subtype are free-form classifications

`ProfilerOutputSchema` SHALL classify the dataset with a free-form `domain`
string and an optional free-form `subtype` string — not a fixed enum and not a
separate omics-classification schema. The profiler SHALL set `domain` to the
scientific domain appropriate to the data it profiled (e.g. `"transcriptomics"`,
`"cheminformatics"`).

#### Scenario: Chemical data is classified as cheminformatics

- **WHEN** the profiler processes an SDF file of molecular structures
- **THEN** it sets `domain: "cheminformatics"` and the file's `dataType` to `"molecular-structures"`

#### Scenario: Any domain string validates

- **WHEN** a profile sets `domain` to an arbitrary scientific-domain string
- **THEN** `ProfilerOutputSchema` validation passes

### Requirement: Profile outputs are registered, indexed, and snapshotted

On success the body SHALL register each staged file as a `role: "input"` artifact
at `data/{relativePath}`, index a per-file description into the analysis vector
store under `type: "input"`, and store a result snapshot — `summary`, file
descriptions, `inputFileIds`, and `profiledAt` — in the `data_profile_status`
ledger via `completeDataProfile`. The profiler's scratch scripts SHALL be
confined to `runs/data-profile/profile`. The run authorization SHALL be revoked
on every terminal path (success, no-op, and failure).

#### Scenario: Successful profile snapshots its inputs

- **WHEN** the body completes a profile over three staged files
- **THEN** three `role: "input"` artifacts exist, three descriptions are indexed under `type: "input"`, and `data_profile_result` holds the summary plus the three `inputFileIds` and a `profiledAt` timestamp

#### Scenario: Authorization revoked on failure

- **WHEN** the body throws after the run is authorized
- **THEN** it marks the profile failed and revokes the run authorization
