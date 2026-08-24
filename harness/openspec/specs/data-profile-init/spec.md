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

The submitted profile SHALL describe the dataset's structure rather than enumerate its
files: `kinds` naming each repeating set with its count and path pattern, `axes` labelling
what varies across members, and `files` describing only those inputs individually notable
enough to warrant prose — a metadata sheet, a README, a paper, an outlier that fits no kind.
The agent SHALL NOT be required to submit metadata for every input file.

#### Scenario: Agent submits its profile

- **WHEN** the data-profiler agent calls `submit_profile` with schema-valid kinds, axes, and notable-file records
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
at `data/{relativePath}`, index the profile into the analysis vector store, and store a
result snapshot in the `data_profile_status` ledger via `completeDataProfile`. The
profiler's scratch scripts SHALL be confined to `runs/data-profile/profile`. The run
authorization SHALL be revoked on every terminal path (success, no-op, and failure).

Indexing SHALL be tiered. The body SHALL index one entry per kind under `type: "input-kind"`
and one entry per entity under `type: "input"`, and SHALL NOT index one entry per file. The
two tiers answer different queries: a query naming a kind of data wants one result carrying
the set's count and path pattern, which a per-entity tier cannot give it; a query naming an
entity wants that entity. A per-file tier adds nothing, because a file is identified by its
kind and entity and its path is on the filesystem.

Index entry text SHALL be composed deterministically from the kind's submitted description
and the entity's axis values. No index entry requires a model call.

Embedding and upsert SHALL be batched. The embedding and vector-store interfaces accept
arrays, and issuing one request per entry makes indexing cost scale as a network round trip
per file.

`type: "input"` SHALL retain its existing meaning for the entity tier so that searches
written against it continue to work; `type: "input-kind"` is additive.

#### Scenario: Successful profile snapshots its inputs

- **WHEN** the body completes a profile over three staged files
- **THEN** three `role: "input"` artifacts exist, the profile's kinds and entities are indexed, and `data_profile_result` holds the profiler's classification plus the input signature and a `profiledAt` timestamp

#### Scenario: Indexing does not scale as a round trip per file

- **GIVEN** a profile over 3513 files forming four kinds across 1171 entities
- **WHEN** the body indexes the profile
- **THEN** it SHALL issue batched embedding requests rather than one request per entry
- **AND** SHALL index four kind entries and 1171 entity entries, and no per-file entries

#### Scenario: Existing input searches keep working

- **WHEN** a consumer searches the vector store filtered to `type: "input"`
- **THEN** it SHALL match the entity tier of a profile written under this requirement

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
`experimentalDesign`, and `qualityAssessment`'s concerns and strengths); the submitted
`kinds` and `axes`; and, per notable file, `path`, `description`, `dataType`, `format`,
`rows`, `cols`, `tags`, `warnings`, and `metrics` — alongside the input signature and
`profiledAt`.

The projection is total because this row is the profile's **only durable home**:
the profiler's `runs/data-profile/` scratch tree is deleted on completion, so a
field dropped here is not "summarized away", it is destroyed, and the next agent
that needs it can only recover it by re-reading the raw input bytes.

The snapshot SHALL NOT carry a record per input file. The workspace filesystem is the
authoritative list of what files exist, and every discovery surface — listing, grep, and
the vector index — reads the live tree; a copy in the ledger is a duplicate that can
disagree with it, and one that this row is detoasted to read on every consumer path,
including the planner's, which reads a few hundred characters of it.

Every field past `summary` / `files` / `profiledAt` SHALL be optional on read: a snapshot
written before the record was widened carries only the fields of its era, and a reader
SHALL render it rather than reject it. There is no parse at the read boundary, so
optionality *is* the compatibility mechanism. `inputFileIds` SHALL be optional on read for
the same reason: rows written before the input signature existed carry it and rows written
after need not.

#### Scenario: The persisted record carries the profiler's classification

- **WHEN** the profiler submits a profile identifying `Homo sapiens` (taxon `9606`, high confidence), a bulk RNA-seq design, and one count matrix with 20,000 rows and 12 columns
- **THEN** `data_profile_result` SHALL carry the organism with its taxon id and confidence, the `experimentalDesign`, and the file's `dataType`, `format`, `rows`, and `cols`

#### Scenario: The persisted record carries the dataset's structure

- **WHEN** the profiler submits a profile with four kinds over 1171 entities
- **THEN** `data_profile_result` SHALL carry the four kinds and their axes
- **AND** SHALL NOT carry 3513 per-file records

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
returns the dataset-level facts, `scope: "kinds"` returns the kinds and axes, and
`scope: "files"` pages the individually described file records (`page`, `pageSize`,
default 20, max 100) and SHALL always report the true `total` and `hasMore`, so an
elided tail is a fact the model can see and act on rather than a silent truncation.

The tool SHALL distinguish the number of files it describes individually from the number of
files in the dataset, and SHALL report both. A profile that describes eight files of several
thousand is correct under this capability, but a `total` that reports only the described
count reads as a dataset of eight files. Where the two differ the tool SHALL direct the agent
to `scope: "kinds"` for the dataset's structure and to the workspace listing tools for paths.

Every lifecycle state SHALL be a data variant in the ok channel, never an error:
`ready`; `stale` (a profile is still returned, with a `staleReason` naming why it
may not describe the current inputs — the input set changed, or a re-profile is
running or has failed over it); `pending`; `failed`; and `absent` (never profiled,
or the analysis has no input files).

The `failed` state SHALL NOT imply a verdict on the analysis's current input files.
It reports a past attempt, and the harness cannot determine on its own whether that
attempt covered the files the analysis holds now: the tool reads one ledger row, and
the current input set is the embedder's knowledge, not the harness's. Reporting a
failure without that qualification is what invites the wrong inference.

The variant SHALL therefore carry `failedAt` — the time the failure was recorded, or
null when the row records none — and its message SHALL state that the failure is a
record of an earlier attempt whose relationship to the current inputs this row cannot
establish. A timestamp is reported because it is a fact the row actually holds and an
agent can act on: an agent that knows when the input set last changed can compare the
two itself.

The tool SHALL NOT report a staleness verdict it cannot derive. In particular it SHALL
NOT expose a field whose value is constant on this path, because a field that cannot
discriminate carries no information while implying that it does — and the tool
description, being the whole of what an agent knows about the tool, SHALL NOT advertise
distinctions the implementation cannot produce.

Where a prior profile DID survive the failure, the row is served as `stale` rather than
`failed`, and that path SHALL continue to name the changed input set through the single
shared staleness predicate. This requirement adds no second definition of staleness and
no sixth lifecycle state.

A profile written before kinds existed SHALL report the `kinds` scope as unavailable for
that snapshot rather than as an empty result, so an agent reads "this profile predates the
structure" rather than "this dataset has no structure".

#### Scenario: A completed profile is served in full

- **WHEN** an agent calls `inspect_data_profile` on an analysis with a completed profile
- **THEN** it receives `state: "ready"` with the dataset-level classification and both the described-file count and the dataset file count

#### Scenario: The kinds scope returns the dataset's structure

- **GIVEN** a profile over 3513 files forming four kinds
- **WHEN** an agent calls `inspect_data_profile` with `scope: "kinds"`
- **THEN** it receives the four kinds with their counts, path patterns, and axes

#### Scenario: A described-file count does not masquerade as the dataset size

- **GIVEN** a profile describing 8 files individually out of 3513 in the dataset
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** the result SHALL report both figures distinctly
- **AND** SHALL direct the agent to the kinds scope for the dataset's structure

#### Scenario: A pre-kinds profile says so

- **GIVEN** a profile written before this capability
- **WHEN** an agent calls `inspect_data_profile` with `scope: "kinds"`
- **THEN** it SHALL report the scope unavailable for that snapshot rather than returning an empty kind list

#### Scenario: A stale profile is served, and says so

- **GIVEN** input files added since the profile was taken
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "stale"` carrying the previous profile AND a `staleReason` naming the changed input set

#### Scenario: A failure is reported as a past attempt, not a verdict

- **GIVEN** a `failed` profile row with no earlier result
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "failed"` with `failedAt` naming when the failure was recorded
- **AND** the message states the failure is an earlier attempt whose relation to the current inputs this row cannot establish

#### Scenario: A row recording no failure time still answers

- **GIVEN** a `failed` profile row whose recorded completion time is absent
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `failedAt: null` rather than a fabricated or omitted value

#### Scenario: No underivable staleness verdict is exposed

- **WHEN** an agent calls `inspect_data_profile` on a `failed` row
- **THEN** the result SHALL NOT carry a field purporting to say whether the input set changed since the failure
- **AND** the tool description SHALL NOT advertise such a distinction

#### Scenario: A surviving prior profile is served as stale, not failed

- **GIVEN** a profile row whose latest attempt failed but which still carries an earlier result
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "stale"` with a `staleReason` naming the failed re-profile

#### Scenario: A paged file scope never truncates silently

- **GIVEN** a profile individually describing 50 files
- **WHEN** an agent calls `inspect_data_profile` with `scope: "files"` and the default page size
- **THEN** it receives 20 records with `total: 50` and `hasMore: true`

#### Scenario: A never-profiled analysis is absent, not an error

- **WHEN** an agent calls `inspect_data_profile` on an analysis with no profile
- **THEN** it receives `state: "absent"` in the ok channel

### Requirement: Grouping the dataset is the agent's judgement, not the scan's

The kinds and axes a profile carries SHALL be the agent's determination. The scan supplies
observations — name structure, variable positions and their value sets, format, headers,
cross-shape value overlap (see the input-scan-manifest spec) — and the agent decides what
constitutes a kind, which variable positions are axes, and what each represents.

`KindSchema` SHALL require the agent to state **what one member of the kind represents** as a
distinct field from the kind's description. That field is the grouping decision made explicit:
it cannot be answered by accepting an observation, because the scan never asserts what a member
is. A schema that asked only for a description would be satisfiable by restating the observed
shape, leaving the agent's central judgement present in the output but never exercised.

`AxisSchema` SHALL require an agent-supplied label. The scan reports that a position varies and
which values it takes; what the variation *is* — a subject, a timepoint, a treatment arm, a
chromosome shard — is not derivable from the values.

The agent's kinds SHALL NOT be constrained to correspond to observed shapes. It MAY split one
shape into several kinds, cover several shapes with one kind, or declare an axis the scan did
not report.

#### Scenario: Each kind states what a member represents

- **WHEN** the agent submits a kind
- **THEN** the submission SHALL carry what one member of that kind represents, distinct from the kind's description

#### Scenario: A categorical variable position is not an entity axis

- **GIVEN** a manifest reporting one shape whose variable position takes the values `tumor` and `normal`
- **WHEN** the agent recognises these as arms of a comparison
- **THEN** it SHALL be able to submit them as two kinds, or as one kind whose axis is labelled as a comparison arm rather than a subject

#### Scenario: The agent declares an axis the scan did not observe

- **GIVEN** an axis evident from a metadata sheet but not from filenames
- **WHEN** the agent submits its profile
- **THEN** the submission SHALL be able to carry that axis

### Requirement: The profiler's output is bounded by kind, not by file count

`ProfilerOutputSchema` SHALL bound every array an agent authors. `kinds` and `files` SHALL
each carry a maximum length, so an output describing an arbitrarily large input tree remains
within a model's output ceiling by construction.

The bound is the enforcement, not the prompt. An unbounded per-file array asked for metadata
the model cannot physically emit — at roughly one hundred tokens per record, a tree of a few
thousand files exceeds any current output ceiling — and the failure was silent: the model
emitted what fitted and the body accepted it. A cap turns that into a validation error the
model is told to correct by grouping.

The governing invariant SHALL be that no field an agent authors grows with the number of
input files or entities. Enumeration of members and files is the scan's responsibility (see
the input-scan-manifest spec); the agent authors kinds.

#### Scenario: An over-long output is refused, not truncated

- **WHEN** the agent submits more kinds or files than the schema permits
- **THEN** `submit_profile` SHALL reject the input as schema-invalid
- **AND** the agent SHALL be able to retry within the bound

#### Scenario: A large tree yields a small output

- **GIVEN** an analysis of 3513 input files forming four repeating sets
- **WHEN** the agent submits its profile
- **THEN** the submitted output SHALL carry four kinds rather than 3513 file records

### Requirement: The persisted profile's shape is a published contract

The stored `data_profile_result` record's type SHALL be declared in the package's
contracts surface, alongside the profile's run literal, and SHALL be importable without
importing the ledger module. It covers the dataset classification, the kinds and axes,
the notable-file records, the input signature, and the coverage figures.

The row is read by consumers the harness does not contain: a host route serving it to a
UI, a UI rendering it. Those consumers need the shape to interpret the row, and the
module that persists it pulls in the database driver and the ledger's whole query
surface — a dependency a renderer has no use for. Declaring the shape where the run
literal already lives puts every name a consumer reads back in one importable place.

The contract SHALL state that compatibility is optionality: there is no parse at the read
boundary, so a field added later is absent from older rows and a consumer SHALL render
such a row rather than reject it.

#### Scenario: A consumer interprets a stored profile without the ledger

- **WHEN** a consumer imports the persisted profile's type
- **THEN** it SHALL obtain it from the contracts surface
- **AND** SHALL NOT need the module that reads or writes the ledger row

#### Scenario: The ledger and the contract do not diverge

- **WHEN** the ledger module names the persisted profile's type
- **THEN** it SHALL be the same declaration the contracts surface publishes

