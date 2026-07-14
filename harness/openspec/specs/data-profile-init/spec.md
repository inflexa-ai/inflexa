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

### Requirement: The staged-input manifest carries a per-file drift signature

Every `StagedInput` the embedder hands the data-profile trigger SHALL carry `mtimeMs: number` — the
source file's last-modification time in epoch milliseconds — alongside the existing `size`. Together
`(fileId, size, mtimeMs)` form the file's **drift signature**: the value a consumer compares against a
completed profile's `inputFiles` to decide whether the same bytes were profiled.

`mtimeMs` SHALL be a value the embedder already holds when it produces the manifest: the CLI reads it
from the `stat` it performs to record `size`; a managed service supplies the object store's
last-modified epoch. The harness treats it, like `fileId`/`key`/`mountName`, as an opaque label — it
never interprets, compares, or validates it, and it never reads the source filesystem.

#### Scenario: The manifest element carries size and mtime

- **WHEN** an embedder constructs a `StagedInput` for a source file
- **THEN** the element SHALL carry the file's `size` in bytes and its `mtimeMs` in epoch milliseconds

#### Scenario: The harness does not interpret the signature

- **WHEN** the data-profile workflow consumes a `StagedInput`
- **THEN** it SHALL persist `mtimeMs` into the completed result's `inputFiles` verbatim
- **AND** it SHALL NOT stat the source file, compare mtimes, or reject a manifest on the basis of them

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
store under `type: "input"`, and store a result snapshot in the
`data_profile_status` ledger via `completeDataProfile`. The profiler's scratch
scripts SHALL be confined to `runs/data-profile/profile`. The run authorization
SHALL be revoked on every terminal path (success, no-op, and failure).

#### Scenario: Successful profile snapshots its inputs

- **WHEN** the body completes a profile over three staged files
- **THEN** three `role: "input"` artifacts exist, three descriptions are indexed under `type: "input"`, and `data_profile_result` holds the profiler's classification plus the three `inputFileIds` and a `profiledAt` timestamp

#### Scenario: Authorization revoked on failure

- **WHEN** the body throws after the run is authorized
- **THEN** it marks the profile failed and revokes the run authorization

### Requirement: The snapshot is the profiler's full output, not a summary of it

`buildDataProfileResult` SHALL project the profiler's structured output into the
persisted `DataProfileResult` **totally** — every field the profiler reported is
carried through verbatim, not condensed. Concretely the snapshot SHALL carry the
dataset-level classification (`summary` from the profiler's `analysisSummary`,
`domain`, `subtype`, `organism` — scientific name, `taxonId`, source, and
confidence — `tissue`, `cellType`, `condition`, `accessions`,
`experimentalDesign`, and `qualityAssessment`'s concerns and strengths) and, per
file, `path`, `description`, `dataType`, `format`, `rows`, `cols`, `tags`,
`warnings`, and `metrics` — alongside `inputFileIds`, `inputFiles`, and
`profiledAt`.

The projection is total because this row is the profile's **only durable home**:
the profiler's `runs/data-profile/` scratch tree is deleted on completion, so a
field dropped here is not "summarized away", it is destroyed, and the next agent
that needs it can only recover it by re-reading the raw input bytes.

Every field past `summary` / `files` / `inputFileIds` / `profiledAt` SHALL be
optional on read: a snapshot written before the record was widened carries only
those four, and a reader SHALL render it rather than reject it. There is no parse
at the read boundary, so optionality *is* the compatibility mechanism.

#### Scenario: The persisted record carries the profiler's classification

- **WHEN** the profiler submits a profile identifying `Homo sapiens` (taxon `9606`, high confidence), a bulk RNA-seq design, and one count matrix with 20,000 rows and 12 columns
- **THEN** `data_profile_result` SHALL carry the organism with its taxon id and confidence, the `experimentalDesign`, and the file's `dataType`, `format`, `rows`, and `cols`

#### Scenario: A legacy snapshot still reads

- **WHEN** a consumer reads a `data_profile_result` written before the record was widened, carrying only `summary`, `files` (path + description), `inputFileIds`, and `profiledAt`
- **THEN** it SHALL render the record, treating the absent fields as not reported

### Requirement: The profile is readable only through inspect_data_profile

There SHALL be no data-profile file anywhere in the workspace — the profiler's
scratch tree is deleted on completion, so the `cortex_analysis_state` row is the
profile's sole durable home. The harness SHALL therefore expose an
`inspect_data_profile` tool that reads that row, wired to the conversation agent
and to **every** sandbox agent as always-on substrate (see the
harness-sandbox-agents spec), and its description SHALL tell the agent that no
profile file exists, so it neither hunts for one nor re-derives the facts from the
raw inputs.

The tool SHALL be bounded by construction: `scope: "overview"` (the default)
returns the dataset-level facts plus the profiled-file count, and `scope: "files"`
pages the per-file records (`page`, `pageSize`, default 20, max 100) and SHALL
always report the true `total` and `hasMore`, so an elided tail is a fact the
model can see and act on rather than a silent truncation.

Every lifecycle state SHALL be a data variant in the ok channel, never an error:
`ready`; `stale` (a profile is still returned, with a `staleReason` naming why it
may not describe the current inputs — the input set changed, or a re-profile is
running or has failed over it); `pending`; `failed`; and `absent` (never profiled,
or the analysis has no input files).

#### Scenario: A completed profile is served in full

- **WHEN** an agent calls `inspect_data_profile` on an analysis with a completed profile
- **THEN** it receives `state: "ready"` with the dataset-level classification and the profiled-file count

#### Scenario: A stale profile is served, and says so

- **GIVEN** input files added since the profile was taken
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "stale"` carrying the previous profile AND a `staleReason` naming the changed input set

#### Scenario: A paged file scope never truncates silently

- **GIVEN** a profile covering 50 files
- **WHEN** an agent calls `inspect_data_profile` with `scope: "files"` and the default page size
- **THEN** it receives 20 records with `total: 50` and `hasMore: true`

#### Scenario: A never-profiled analysis is absent, not an error

- **WHEN** an agent calls `inspect_data_profile` on an analysis with no profile
- **THEN** it receives `state: "absent"` in the ok channel
