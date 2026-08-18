## ADDED Requirements

### Requirement: Re-profiling is invoked by the embedder, never derived on read

A re-profile SHALL be invoked by the party that changed the analysis's input set, at the
moment it changes. No harness read path SHALL decide, from a stored profile and a stored
seed, that a profile needs re-running.

The harness holds no current input set. The managed service holds `seed_input_file_ids` —
ids it wrote itself at the last seed — so comparing them against a profile derived from
that same seed can only detect a disagreement between two of its own writes, never a
divergence from the authority that owns the files. The CLI holds the live tree but reaches
it only when a chat opens, which is not when the tree changed. Both, however, are present
at the mutation: the managed service enqueues its reprofile job inside the input-mutation
transaction, and the CLI emits an in-process input event on the same edge.

A read path MAY report what the ledger row states — an attempt in flight over a preserved
prior result, or a failed attempt over one. It SHALL NOT infer, from the row, a fact about
files it cannot see.

#### Scenario: A completed row whose seed names unprofiled files is not re-triggered

- **GIVEN** a `completed` profile row whose `seed_input_file_ids` names files the stored result never covered
- **WHEN** any harness read path reads that row
- **THEN** it SHALL report the profile as current
- **AND** no re-profile SHALL be triggered by the read

#### Scenario: The mutation edge is what re-profiles

- **WHEN** an embedder adds or removes an analysis input
- **THEN** the embedder SHALL invoke the re-profile on that edge, rather than relying on a later read to notice

## MODIFIED Requirements

### Requirement: Result snapshot carries the profiled input set

The `data_profile_result` JSONB stored by `completeDataProfile` SHALL carry, in addition to the
profiler's full output (the dataset classification, the kinds and axes, and the notable-file
records — see the data-profile-init spec):

- `inputSignature: { count: number; digest: string }` — the record of *which* files a profile
  covered and *whether the same bytes* were profiled. `count` is the number of staged inputs;
  `digest` is a stable hash over the staged inputs' identities and their per-file size and mtime,
  computed in a canonical order so the value depends on the set and not on enumeration order.
- `profiledAt: string` — ISO 8601 timestamp of profile completion

The signature is an **audit record**, not a decision input. Nothing in the harness compares it
against a current input set, because no harness read path holds one; re-profiling is invoked at
the mutation instead. It is written because it is the only durable answer to "which files did this
profile cover?", it costs one hash over a manifest already in hand, and its absence would be
unrecoverable after the fact — whereas a reader can be added back at any time.

`inputFileIds: string[]` and `inputFiles: { fileId, size, mtimeMs }[]` SHALL remain readable on
rows written before the signature existed. They SHALL NOT be written by a current profile body.

The signature deliberately excludes the content hash: it is computed from the staged manifest,
which carries size and mtime, and reading every input in full to record a stronger value would
cost the whole dataset at every profile completion for a field nothing compares.

#### Scenario: Initial profile stores the input signature

- **WHEN** the data-profile body completes for an analysis with 3 staged input files
- **THEN** `data_profile_result.inputSignature.count` SHALL be 3
- **AND** `data_profile_result.inputSignature.digest` SHALL be a stable hash over those inputs' identities, sizes, and mtimes
- **AND** `data_profile_result.profiledAt` SHALL be an ISO 8601 timestamp near the completion time

#### Scenario: The signature is order-independent

- **GIVEN** two enumerations of the same input set differing only in order
- **WHEN** the signature is computed over each
- **THEN** the two digests SHALL be equal

#### Scenario: A re-profile replaces the recorded signature

- **WHEN** the body completes again after the input set changed
- **THEN** `data_profile_result.inputSignature` SHALL describe the set the new run covered
- **AND** `data_profile_result.profiledAt` SHALL be updated to the new completion time

#### Scenario: A legacy snapshot's comparand is still readable

- **GIVEN** a snapshot written before `inputSignature` existed, carrying `inputFileIds`
- **WHEN** a consumer reads the row
- **THEN** the field SHALL still deserialize, and its absence on a current row SHALL NOT be an error
