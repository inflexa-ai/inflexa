## MODIFIED Requirements

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
and the persisted profile.

Embedding and upsert SHALL be batched. The embedding and vector-store interfaces accept
arrays, and issuing one request per entry makes indexing cost scale as a network round
trip per entry.

#### Scenario: Three tiers are written

- **WHEN** the body indexes a resolved profile with groups, dimensions, and member annotations
- **THEN** it SHALL write group entries, dimension entries, and one entry per annotated member
- **AND** SHALL NOT write entries for unannotated members

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
`caveats` is agent-authored only. The snapshot SHALL NOT carry `qualityAssessment.strengths`
— nothing consumed it — and a legacy row carrying it SHALL still render.

The writer SHALL emit `groups` and `dimensions` only; it SHALL NOT write `kinds` or
`axes`. Readers SHALL keep accepting legacy snapshots carrying `kinds`/`axes` — every
field past the original core remains optional on read, a snapshot carries the fields of
its era, and a reader renders it rather than rejects it. There SHALL be no schema version
field: optionality is the compatibility mechanism, and a discriminator would be a second
mechanism answering the same question.

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
- **THEN** it SHALL NOT carry `qualityAssessment.strengths`
- **AND** a legacy row carrying strengths SHALL still render

#### Scenario: Computed facts are not caveats

- **GIVEN** a group where resolution found members missing an expected companion
- **WHEN** the snapshot is written
- **THEN** the gap SHALL appear in the structured completeness field, not appended to the agent's caveats

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

## ADDED Requirements

### Requirement: Every kept file belongs to exactly one group

Resolution SHALL enforce a partition over the kept files: every file the scan did not
quarantine lands in exactly one group. Operations whose memberships overlap SHALL be a
resolution error returned for repair, not resolved by precedence. Files no operation
claims survive the repair round SHALL be swept into a visible `unclassified` group —
membership is exhaustive by construction, and the sweep is reported, never silent.

The accounting SHALL be derived, never declared: kept equals the sum over groups
including `unclassified`; quarantined files are accounted separately with their reasons.

The partition is what makes downstream consumption sound: a planner reading groups can
trust that the groups are the dataset, an index built from groups reaches every kept
file's group, and "how much did the profile cover" stops being a question — it is a
census.

#### Scenario: Overlapping operations are a repair, not a precedence

- **WHEN** two submitted operations claim the same file
- **THEN** resolution SHALL fail with an error naming the overlap
- **AND** the body SHALL return it to the agent for the repair round

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
  a group whose template has no such slot is unwritable.
- **Column observation** — names the file and column the agent read; dataset-scoped by
  construction.
- **Document observation** — cites the metadata document or mapping file.

Cross-source identity overlap SHALL be recorded only as a performed measurement —
`checked: { matched, of }` — and the field SHALL be absent when no check was performed. A
boolean claim of no-overlap is unrepresentable, because it asserts an exhaustive check
that never happened.

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
outside the catalogue is representable without diluting the catalogue. Each completed
profile SHALL emit one structured log event carrying the monitoring counters — `other`
usage, unclassified size, probe not-founds, repair rounds — because those counters are
how the catalogue's fit is measured against real use.

#### Scenario: An unknown category is refused

- **WHEN** the agent submits a group whose category is not in the shipped vocabulary and not `other`
- **THEN** `submit_profile` SHALL reject the submission as schema-invalid

#### Scenario: Prompt and validator read one source

- **WHEN** the profiler prompt renders the category catalogue
- **THEN** it SHALL render from the same shipped data the submit validation enforces

#### Scenario: A profile emits its monitoring event

- **WHEN** a profile completes
- **THEN** one structured log event SHALL carry the `other`-usage, unclassified, probe-not-found, and repair-round counters

### Requirement: The rendered orientation leads with structure, not prose

The orientation rendered from the profile SHALL put the file census in its header —
kept-file count, group count, unclassified count, quarantined count — where no clamp can
remove it. Section order SHALL be identity, census, groups, dimensions (with side-by-side
observation numbers), experimental design, then caveats. Caveats SHALL be capped per item
and as a share of the whole rendering, so structured facts are never crowded out by prose.

#### Scenario: The census survives the clamp

- **GIVEN** an orientation rendering clamped to its budget
- **WHEN** a consumer reads it
- **THEN** the census line SHALL be present regardless of what the clamp removed

#### Scenario: Prose cannot crowd out structure

- **GIVEN** a profile with long caveats
- **WHEN** the orientation renders
- **THEN** the caveats SHALL be capped per item and in total share
- **AND** the groups and dimensions sections SHALL render in full before any prose expands
