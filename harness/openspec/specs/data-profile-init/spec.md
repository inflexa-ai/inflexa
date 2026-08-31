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
`(fileId, size, mtimeMs)` form the file's **drift signature**: what feeds the kept-files
`inputSignature` a completed profile persists, the comparand that decides whether the same bytes
were profiled.

`mtimeMs` SHALL be a value the embedder already holds when it produces the manifest: the CLI reads it
from the `stat` it performs to record `size`; a managed service supplies the object store's
last-modified epoch. The harness treats it, like `fileId`/`key`/`mountName`, as an opaque label — it
never interprets, compares, or validates it, and it never reads the source filesystem.

#### Scenario: The manifest element carries size and mtime

- **WHEN** an embedder constructs a `StagedInput` for a source file
- **THEN** the element SHALL carry the file's `size` in bytes and its `mtimeMs` in epoch milliseconds

#### Scenario: The harness does not interpret the signature

- **WHEN** the data-profile workflow consumes a `StagedInput`
- **THEN** it SHALL fold `mtimeMs` verbatim into the input signature the completed result persists
- **AND** it SHALL NOT stat the source file, compare mtimes, or reject a manifest on the basis of them

### Requirement: The data-profiler agent delivers results through a terminal submit_profile tool

The body SHALL run the `data-profiler` sandbox agent via `runToTerminal` (see the
harness-agent-loop spec) with a terminal `submit_profile` tool. The agent's profiling
result SHALL be delivered only through that tool; the body SHALL NOT parse result JSON
from the agent's message text. If the agent never calls `submit_profile` — even after the
salvage continuation — the body SHALL fail the profile.

The submission SHALL carry menu operations, group annotations (meaning, role, category,
description, member annotations for individually notable files), and dimensions with their
observations. Operations SHALL address top-level menu identifiers exclusively; a
`scan_inputs` re-scan is informational and mints no new addressable entries.

The body SHALL resolve the submission deterministically: compute each group's membership
from its operations, derive counts, and verify the partition (see "Every kept file belongs
to exactly one group"). Declared counts SHALL NOT exist — a count the resolution can
compute is not the agent's to assert.

A submission that fails resolution SHALL be returned to the live agent once with the
resolution errors, and repair SHALL be a full resubmit — the agent replaces the whole
operation list; the body SHALL NOT merge a partial correction into a prior submission.

A tree the scan kept nothing of SHALL NOT reach the agent at all. There is no menu to
author against and no file to describe, so a sandbox and a model pass would buy an empty
submission; the body SHALL complete on the census it already holds — zero groups against
the full quarantine accounting with its reasons — and consumers SHALL read that as a
structure record reporting no groups, never as an analysis that was never profiled.

#### Scenario: Membership is computed, not declared

- **WHEN** the agent submits a `use` of a detected set
- **THEN** the group's membership and count SHALL be computed from the scanner's template at resolution
- **AND** the submission schema SHALL carry no count field for the agent to fill

#### Scenario: A failed resolution gets one repair round

- **WHEN** a submission's operations fail resolution
- **THEN** the body SHALL return the errors to the agent once and accept a full replacement submission

#### Scenario: Agent never submits

- **WHEN** the agent reaches a terminal state without ever calling `submit_profile`, including the salvage continuation
- **THEN** the body fails the profile with an error and revokes the run authorization

#### Scenario: A wholly quarantined tree needs no agent at all

- **GIVEN** staged inputs the scan quarantines in full
- **THEN** the body SHALL complete the profile with no groups and the full quarantine accounting, provisioning no sandbox and calling no model
- **AND** `inspect_data_profile` SHALL serve its structure scope as available rather than reporting the profile carries none

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

On success the body SHALL register each staged file as a `role: "input"` artifact at
`data/{relativePath}`, index the profile into the analysis vector store, and store a
result snapshot in the `data_profile_status` ledger via `completeDataProfile`. The
profiler's scratch scripts SHALL be confined to `runs/data-profile/profile`. The run
authorization SHALL be revoked on every terminal path (success, no-op, and failure).

Indexing SHALL be tiered three ways. The body SHALL index one entry per group under
`type: "input-group"`, one entry per dimension under `type: "input-dimension"`, and one
entry per **annotated member** under the existing `type: "input"` — a member the agent
wrote an individual annotation for is searchable by it; members without annotations are
reachable through their group and the filesystem. The body SHALL NOT index every member:
thousands of near-duplicate entries composed from the same group text add recall noise,
not recall.

Index entry text SHALL be composed deterministically from the group's submitted meaning
and description, the dimension's observations, and the member's annotation. No index entry
requires a model call. The index SHALL remain a pure projection, rebuildable from the tree
and the persisted profile — so indexing SHALL REPLACE rather than merge: the entries the
profile's own tiers hold are cleared before the rebuild, because an upsert keyed by entry
id leaves a renamed group, a dropped dimension, and a de-annotated member searchable
forever. The clearing SHALL be scoped to the tiers a profile writes; step outputs,
summaries, and syntheses SHALL be untouched.

Embedding and upsert SHALL be batched. The embedding and vector-store interfaces accept
arrays, and issuing one request per entry makes indexing cost scale as a network round
trip per entry.

#### Scenario: Three tiers are written

- **WHEN** the body indexes a resolved profile with groups, dimensions, and member annotations
- **THEN** it SHALL write group entries, dimension entries, and one entry per annotated member
- **AND** SHALL NOT write entries for unannotated members

#### Scenario: A renamed group leaves no stale entry

- **GIVEN** an indexed profile
- **WHEN** the analysis is re-profiled and a group's name changes
- **THEN** the index SHALL hold the new group's entry and not the old one
- **AND** the step-output, summary, and synthesis entries SHALL remain

#### Scenario: Existing input searches keep working

- **WHEN** a consumer searches the vector store filtered to `type: "input"`
- **THEN** it SHALL match the annotated members of a profile written under this requirement

#### Scenario: Indexing does not scale as a round trip per entry

- **WHEN** the body indexes the profile
- **THEN** it SHALL issue batched embedding requests rather than one request per entry

#### Scenario: Authorization revoked on failure

- **WHEN** the body throws after the run is authorized
- **THEN** it marks the profile failed and revokes the run authorization

### Requirement: The snapshot is the profiler's full output, not a summary of it

`buildDataProfileResult` SHALL project the resolved profile into the persisted
`DataProfileResult` **totally** — every field the agent reported and every fact resolution
computed is carried through, not condensed. Concretely the snapshot SHALL carry:

- the dataset-level classification (`summary`, `domain`, `subtype`, `organism` with
  source and confidence, `tissue`, `cellType`, `condition`, `accessions`,
  `experimentalDesign`);
- the resolved `groups`: per group its meaning, role, category, description, derived
  count, display pattern, slots (token class, cardinality, bounded value sample — never
  full value enumerations), member annotations, and computed per-member companion
  completeness;
- the `dimensions` with their observations, reconciliation notes, and nesting relations;
- the partition accounting (kept, per-group, `unclassified`, quarantined with reasons);
- the operations recipe, keyed to scanner templates (see the data-profile-rerun spec);
- the input signature and `profiledAt`.

Computed facts and agent-authored caveats SHALL NOT mix: companion gaps, incomplete slot
crossings, and reconciliation deltas live in structured fields the resolution writes;
`caveats` is agent-authored only. `qualityAssessment.strengths` SHALL NOT be declared by
the record type — nothing ever consumed it — and a legacy row carrying the key SHALL
still render, the key ignored on read.

The writer SHALL emit `groups` and `dimensions` only; it SHALL NOT write `kinds` or
`axes`. Readers SHALL keep accepting legacy snapshots carrying `kinds`/`axes` — every
legacy field a reader still renders remains optional on read, a snapshot carries the
fields of its era, and a reader renders it rather than rejects it. A legacy field
nothing reads any more is retired from the record type outright, its key ignored on
rows that carry it. There SHALL be no schema version field: optionality is the
compatibility mechanism, and a discriminator would be a second mechanism answering the
same question.

The snapshot SHALL NOT carry a record per input file. The workspace filesystem is the
authoritative list of what exists; the snapshot carries structure and judgement.

#### Scenario: The persisted record carries the resolved structure

- **WHEN** the agent's operations resolve to groups over a tree with dimensions observed
- **THEN** `data_profile_result` SHALL carry the groups with derived counts and slots, the dimensions with observations, the partition accounting, and the operations recipe

#### Scenario: A legacy kinds-and-axes snapshot still reads

- **WHEN** a consumer reads a snapshot written under the previous model, carrying `kinds` and `axes`
- **THEN** it SHALL render the record, treating the absent new fields as not reported
- **AND** no version field SHALL be consulted, because none exists

#### Scenario: Strengths are gone from new rows and harmless in old ones

- **WHEN** a new profile is persisted
- **THEN** it SHALL NOT carry `qualityAssessment.strengths`, which the record type does not declare
- **AND** a legacy row carrying the key SHALL still render, the key ignored on read

#### Scenario: Computed facts are not caveats

- **GIVEN** a group where resolution found members missing an expected companion
- **WHEN** the snapshot is written
- **THEN** the gap SHALL appear in the structured completeness field, not appended to the agent's caveats

### Requirement: The profile is readable only through inspect_data_profile

There SHALL be no data-profile file anywhere in the workspace — the profiler's scratch
tree is deleted on completion, so the `cortex_analysis_state` row is the profile's sole
durable home. The harness SHALL therefore expose an `inspect_data_profile` tool that
reads that row, wired to the conversation agent and to **every** sandbox agent as
always-on substrate (see the harness-sandbox-agents spec), and its description SHALL tell
the agent that no profile file exists.

The tool SHALL be bounded by construction: `scope: "overview"` (the default) returns the
dataset-level facts and the partition accounting, `scope: "groups"` returns the groups
with their slots and the dimensions with their observations, and `scope: "files"` pages
the individually annotated member records (`page`, `pageSize`, default 20, max 100),
always reporting the true `total` and `hasMore`.

The tool SHALL distinguish the number of members annotated individually from the number
of files in the dataset, and SHALL report both, directing the agent to `scope: "groups"`
for structure and to the workspace listing tools for paths.

For a legacy snapshot the `groups` scope SHALL serve the stored `kinds` and `axes`,
labelled as authored under the previous model, rather than reporting the scope
unavailable — the structure exists and an agent SHALL NOT be told the dataset has none.

Every lifecycle state SHALL remain a data variant in the ok channel — `ready`, `stale`,
`pending`, `failed`, `absent` — with the failed-state semantics unchanged: a failure is a
past attempt, `failedAt` carries the recorded time or null, no underivable staleness
verdict is exposed, and a surviving prior profile is served as `stale` rather than
`failed` through the single shared staleness predicate.

#### Scenario: The groups scope returns the resolved structure

- **GIVEN** a completed profile over a tree resolved into groups with dimensions
- **WHEN** an agent calls `inspect_data_profile` with `scope: "groups"`
- **THEN** it receives the groups with derived counts, display patterns, and slots, and the dimensions with their observations

#### Scenario: A legacy snapshot's structure is served, labelled

- **GIVEN** a snapshot written under the previous model
- **WHEN** an agent calls `inspect_data_profile` with `scope: "groups"`
- **THEN** it receives the stored kinds and axes, labelled as authored under the previous model

#### Scenario: The overview carries the accounting

- **WHEN** an agent calls `inspect_data_profile` on a completed profile
- **THEN** the overview SHALL report the kept, unclassified, and quarantined counts alongside the classification

#### Scenario: An annotated-member count does not masquerade as the dataset size

- **GIVEN** a profile annotating 8 members out of thousands of files
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** the result SHALL report both figures distinctly

### Requirement: Grouping the dataset is the agent's judgement, not the scan's

The groups and dimensions a profile carries SHALL be the agent's determination. The scan
supplies observations — detected sets, slots with value samples, formats, headers,
cross-set slot overlap (see the input-scan-manifest spec) — and the agent decides what
constitutes a group, which slots evidence a dimension, and what each represents.

The judgement SHALL be expressed exclusively through operations on the menu: `use` a
detected set as a group, `split` a set by a slot or by an explicit value mapping, `merge`
sets into one group, or `group` an explicit path list the scan left ungrouped. The agent
SHALL NOT author path patterns; pattern text in the stored profile is display-only,
derived from the scanner's templates.

Each group SHALL state **what one member of the group represents** as a distinct field
from the group's description — the grouping decision made explicit, unanswerable by
restating an observation. Each group SHALL carry a role and a category drawn from the
shipped vocabulary (see "The vocabulary ships as data"); the scanner MAY pre-suggest a
category only where near-certain, and the agent confirms or overrides.

The agent's groups SHALL NOT be constrained to correspond to detected sets: split, merge,
and explicit path grouping exist because they do not.

#### Scenario: Each group states what a member represents

- **WHEN** the agent submits its operations
- **THEN** every resulting group SHALL carry what one member represents, distinct from the group's description

#### Scenario: A categorical slot is split by value mapping

- **GIVEN** a detected set whose slot takes values the agent recognises as two different substrates
- **WHEN** the agent submits a split of that set by a value mapping
- **THEN** the body SHALL resolve two groups whose memberships are computed from the mapping

#### Scenario: A pre-suggested category is the agent's to override

- **GIVEN** a set the scanner pre-suggested as variant calls
- **WHEN** the agent determines the files are something else
- **THEN** it SHALL be able to submit the group under a different category

### Requirement: The persisted profile's shape is a published contract

The stored `data_profile_result` record's type SHALL be declared in the package's
contracts surface, alongside the profile's run literal, and SHALL be importable without
importing the ledger module. It covers the dataset classification, the groups with their
slots and annotations, the dimensions with their observations, the partition accounting,
the operations recipe, the input signature, and the coverage-era legacy fields.

The contract SHALL state that compatibility is optionality: there is no parse at the read
boundary, so a field added later is absent from older rows and a consumer SHALL render
such a row rather than reject it. The contract SHALL carry the legacy `kinds`/`axes`
fields as optional-on-read for the same reason.

#### Scenario: A consumer interprets a stored profile without the ledger

- **WHEN** a consumer imports the persisted profile's type
- **THEN** it SHALL obtain it from the contracts surface
- **AND** SHALL NOT need the module that reads or writes the ledger row

#### Scenario: The ledger and the contract do not diverge

- **WHEN** the ledger module names the persisted profile's type
- **THEN** it SHALL be the same declaration the contracts surface publishes

### Requirement: The profiler's output is bounded by the menu, not by file count

The submission schema SHALL bound every array the agent authors: the operation list is
bounded by the menu's own bound, and member annotations carry a maximum length. The
governing invariant SHALL be that no field an agent authors grows with the number of input
files or entities — enumeration is the scan's job, membership is resolution's job, and the
agent authors judgement.

The bound is the enforcement, not the prompt: an over-long submission SHALL be a schema
error the agent corrects, never a silent truncation.

#### Scenario: An over-long output is refused, not truncated

- **WHEN** the agent submits more operations or annotations than the schema permits
- **THEN** `submit_profile` SHALL reject the input as schema-invalid
- **AND** the agent SHALL be able to retry within the bound

#### Scenario: A large tree yields a small submission

- **GIVEN** an analysis of thousands of input files forming a handful of detected sets
- **WHEN** the agent submits its profile
- **THEN** the submission SHALL carry a handful of operations rather than per-file records

### Requirement: Every kept file belongs to exactly one group

Resolution SHALL enforce a partition over the kept files: every file the scan did not
quarantine lands in exactly one group. Operations whose memberships overlap SHALL be a
resolution error returned for repair, not resolved by precedence. Files no operation
claims survive the repair round SHALL be swept into a visible `unclassified` group —
membership is exhaustive by construction, and the sweep is reported, never silent.

Past the last repair round there is no agent left to return an overlap to. A file still
claimed by more than one operation SHALL then be removed from EVERY claimant and swept
into `unclassified`, and the count and a bounded sample of such files SHALL be recorded in
the accounting and in the monitoring event. It SHALL NOT be awarded to one claimant by
precedence, and SHALL NOT be counted twice. The partition therefore holds at every round,
whatever the submission: no kept file is claimed by two groups, and none is left out.

The accounting SHALL be derived, never declared: kept equals the sum over groups
including `unclassified`; quarantined files are accounted separately with their reasons.
When the scan's walk stopped at its file ceiling, the accounting SHALL say so — every
figure it carries is then a figure over part of the tree.

The partition is what makes downstream consumption sound: a planner reading groups can
trust that the groups are the dataset, an index built from groups reaches every kept
file's group, and "how much did the profile cover" stops being a question — it is a
census.

#### Scenario: Overlapping operations are a repair, not a precedence

- **WHEN** two submitted operations claim the same file
- **THEN** resolution SHALL fail with an error naming the overlap
- **AND** the body SHALL return it to the agent for the repair round

#### Scenario: A still-contested file on the last round is swept, not awarded

- **GIVEN** a repaired submission whose operations still claim the same file twice
- **WHEN** resolution completes
- **THEN** that file SHALL belong to `unclassified` and to neither claimant
- **AND** the accounting SHALL report how many files were contested, with example paths

#### Scenario: Unclaimed residue sweeps visibly

- **GIVEN** a repaired submission that still claims none of a handful of files
- **WHEN** resolution completes
- **THEN** those files SHALL form the `unclassified` group, visible in the profile and its accounting

#### Scenario: The accounting sums

- **WHEN** a profile completes
- **THEN** the kept-file count SHALL equal the sum of all group counts including `unclassified`
- **AND** the quarantined count SHALL be reported separately

### Requirement: Dimensions carry corroborating observations, never bare claims

A dimension SHALL NOT exist without at least one observation, and an observation SHALL
NOT exist without evidence. Observation kinds:

- **Slot observation** — bound to a scanner slot; cardinality and values are computed,
  not asserted. Slot bindings SHALL be the **only** way a group links to a dimension:
  there is no freehand "group varies by X" field, so a per-subject dimension attached to
  a group whose template has no such slot is unwritable. The binding SHALL be persisted
  in terms that outlive the scan that made it — the addressed set's template plus the
  slot's position within it — so it can be re-resolved and its numbers recomputed against
  a later scan (see the data-profile-rerun spec).
- **Column observation** — names the file and column the agent read; dataset-scoped by
  construction.
- **Document observation** — cites the metadata document or mapping file.

Cross-source identity overlap SHALL be recorded only as a performed measurement —
`checked: { matched, of }` — and the field SHALL be absent when no check was performed. A
boolean claim of no-overlap is unrepresentable, because it asserts an exhaustive check
that never happened. Two slots the SCAN itself linked as one identity SHALL NOT be
compared this way: the scan already matched them member by member and counted the
disagreements, while their recorded values differ textually wherever affix recovery
stripped literal text from one side. Comparing them would persist a claim of total
disjointness over a one-to-one correspondence. The scan's own link and its mismatch count
SHALL be carried on the observation instead, and `checked` SHALL stay absent.

There SHALL be no single canonical cardinality. Observations that disagree — metadata
describing one count, files existing for another — both stand, and the reconciliation
note carries the delta; renderers show the numbers side by side.

Naming a slot SHALL NOT itself promote a dimension: technical single-set slots stay on
the set, and the dataset-level dimension list is reserved for biological or cross-set
variation. A value constant across the dataset is not a dimension; it belongs in the
identity fields. Dimensions MAY declare a `nests under` relation, evidenced by path
structure or a mapping file.

#### Scenario: A dimension without evidence is unsubmittable

- **WHEN** the agent submits a dimension carrying no observation
- **THEN** `submit_profile` SHALL reject the submission as schema-invalid

#### Scenario: Disagreement is carried, not resolved

- **GIVEN** a metadata sheet describing more subjects than files exist for
- **WHEN** the agent records both observations
- **THEN** the profile SHALL carry both numbers and a reconciliation note with the delta
- **AND** SHALL NOT carry a single resolved subject count

#### Scenario: A scanner-linked pair is not measured as if it were two sources

- **GIVEN** a set whose directory slot and stem slot the scan linked as one identity
- **WHEN** a dimension observes both
- **THEN** the profile SHALL carry the scan's link and its mismatch count
- **AND** SHALL NOT carry a `checked` measurement over their recorded value sets

#### Scenario: An unchecked overlap is absent, not false

- **GIVEN** two observations of the same dimension whose value overlap was never measured
- **WHEN** the profile is persisted
- **THEN** the `checked` field SHALL be absent
- **AND** SHALL NOT read as a claim that the sources disagree or agree

#### Scenario: A group links to a dimension only through a slot

- **WHEN** the agent attributes per-subject variation to a group
- **THEN** the link SHALL be a binding to one of that group's slots
- **AND** a group with no such slot SHALL be unlinkable to that dimension

### Requirement: The vocabulary ships as data with the package

The vocabulary SHALL ship as data in the package, versioned with the harness: the group
roles and categories, the dimension categories with their anti-overlap notes and
per-category default treatment (split-worthy vs dimension-only, governed by the substrate
test), and the probe list. Prompt assembly and submit validation SHALL consume the same shipped data, so
the vocabulary the agent is shown and the vocabulary the validator enforces cannot
diverge. Hosts SHALL NOT extend the vocabulary.

Category enums SHALL be closed with an `other` escape carrying a free label, so a dataset
outside the catalogue is representable without diluting the catalogue. A dimension's scope
is derived from its category and is never the agent's to assert — except under `other`,
which is by definition outside the catalogue and has nothing to derive from: there the
agent MAY declare the scope, defaulting to technical. Each completed profile SHALL emit one
structured log event carrying the monitoring counters — `other` usage, unclassified size,
contested files, probe not-founds, repair rounds — because those counters are how the
catalogue's fit is measured against real use. **Every** completed profile emits one,
including a profile that completed over an empty manifest or a wholly quarantined tree: a
completion nobody counted is a completion the monitoring cannot see.

#### Scenario: An unknown category is refused

- **WHEN** the agent submits a group whose category is not in the shipped vocabulary and not `other`
- **THEN** `submit_profile` SHALL reject the submission as schema-invalid

#### Scenario: Prompt and validator read one source

- **WHEN** the profiler prompt renders the category catalogue
- **THEN** it SHALL render from the same shipped data the submit validation enforces

#### Scenario: A profile emits its monitoring event

- **WHEN** a profile completes
- **THEN** one structured log event SHALL carry the `other`-usage, unclassified, contested, probe-not-found, and repair-round counters
- **AND** it SHALL be emitted for a profile that completed with nothing to group as well

### Requirement: The rendered orientation leads with structure, not prose

The orientation rendered from the profile SHALL put the file census in its header —
kept-file count, group count, unclassified count, quarantined count, and whether the scan
covered the whole tree — where no clamp can remove it. Section order SHALL be identity,
census, groups, dimensions, the individually annotated members, experimental design, then
caveats.

**Every** group SHALL render, one line each: its name, its member count, its format
census, its category, and what one member represents. A group SHALL be elided only when
one line apiece already exceeds the whole budget, and the count of groups that did not fit
SHALL then be stated outright. The rendering SHALL NOT carry a fixed cap on how many groups
it will show: the submission schema already bounds what an agent may author, so a cap here
would discard resolved structure to make room for prose about it.

Each group whose members vary SHALL be followed by a compact line naming its slots — where
each slot sits, its token class, how many distinct values it takes, and those values inline
while the slot is categorical enough for them to mean something. Slots are how an execution
agent addresses an individual file, so they ride with the group rather than being left to a
follow-up tool call.

Dimensions SHALL render one line each with their observation cardinalities side by side and
any nesting relation. The individually annotated members SHALL render as notable files —
path and annotation — on a bounded count that states the true total.

Prose SHALL render last and SHALL be the only thing a clamp may cut. Caveats SHALL be
capped per item and as a share of the whole rendering. Structured lines are reserved
first — header, groups with their slots, dimensions, notable files — and the design note
and caveats take whatever budget remains.

The section budgets SHALL compose rather than stack: sections are fitted in order against
the budget that remains, a structured entry is dropped whole rather than cut mid-line, and
whatever the budget removed SHALL be marked. A rendering that silently lost a section reads
as a profile that never had one.

#### Scenario: The census survives the clamp

- **GIVEN** an orientation rendering clamped to its budget
- **WHEN** a consumer reads it
- **THEN** the census line SHALL be present regardless of what the clamp removed

#### Scenario: Prose cannot crowd out structure

- **GIVEN** a profile with many groups, a long design note, and long caveats
- **WHEN** the orientation renders
- **THEN** every group SHALL render on its own line, each followed by its slots
- **AND** the caveats SHALL be capped per item and in total share
- **AND** the design note and the caveats SHALL be the only sections a clamp cut

#### Scenario: Slots ride with the group they belong to

- **GIVEN** a group whose members vary at a directory slot and a filename slot
- **WHEN** the orientation renders
- **THEN** the line after that group SHALL name both slots with their token classes and distinct counts
- **AND** a categorical slot's values SHALL appear inline

#### Scenario: What the budget removed is marked

- **GIVEN** a profile with more structure and prose than the budget holds
- **WHEN** the orientation renders
- **THEN** no rendered line SHALL be cut mid-word by the budget
- **AND** the rendering SHALL carry a marker saying something was removed
- **AND** an elided group tail SHALL state how many groups did not fit

### Requirement: The profile run carries the farm-extension seam

The deps bag of the profiler MUST carry the farm-extension seam when the
embedder binds one. The always-on substrate then attaches `link_packages`,
per the harness-sandbox-agents requirement. Thus the profiler links a reader
that the farm does not hold yet. An unbound seam keeps the current shape: no
link tool, and no error.

#### Scenario: The profiler links a reader before the first plan

- **GIVEN** a new analysis whose farm holds no packages, and a bound farm-extension seam
- **WHEN** the profiler meets an input that its scripts cannot read
- **THEN** it links the reader with `link_packages`, and the profile continues

#### Scenario: An unbound seam changes nothing

- **GIVEN** an embedder that binds no farm-extension seam
- **WHEN** the profile runs
- **THEN** the profiler has no `link_packages`, and the composition does not throw

