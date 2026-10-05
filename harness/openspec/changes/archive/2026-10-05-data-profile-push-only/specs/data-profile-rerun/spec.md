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

### Requirement: The result snapshot records the profiled input set

The `data_profile_result` JSONB stored by `completeDataProfile` SHALL carry, in addition
to the resolved profile (see the data-profile-init spec):

- `inputSignature: { count: number; digest: string }` — the record of *which* files a
  profile covered and *whether the same bytes* were profiled. `count` is the number of
  **kept** staged inputs; `digest` is a stable hash over the kept inputs' identities and
  their per-file size and mtime, computed in a canonical order so the value depends on
  the set and not on enumeration order.
- `profiledAt: string` — ISO 8601 timestamp of profile completion

The signature SHALL digest **kept files only**. Quarantined junk and partial-download
artifacts SHALL NOT change it: a temp file is not part of what was profiled. A change to
the quarantine rules themselves changes the signature the next profile records, which is
the correct consequence — the definition of "kept" changed.

The signature is an **audit record**, not a decision input. Nothing in the harness compares it
against a current input set, because no harness read path holds one; re-profiling is invoked at
the mutation instead. It is written because it is the only durable answer to "which files did this
profile cover?", it costs one hash over a manifest already in hand, and its absence would be
unrecoverable after the fact — whereas a reader can be added back at any time.

The retired per-file comparands (`inputFileIds`, `inputFiles`) SHALL NOT be declared by
the record type, and a current profile body SHALL NOT write them. A snapshot written
before the signature existed is still served: unknown keys on such a row are ignored on
read, and the absence of `inputSignature` is neither an error nor a reason to re-profile.

The signature deliberately excludes the content hash: it is computed from the staged manifest,
which carries size and mtime, and reading every input in full to record a stronger value would
cost the whole dataset at every profile completion for a field nothing compares.

#### Scenario: Initial profile stores the input signature

- **WHEN** the data-profile body completes for an analysis with 3 kept staged input files
- **THEN** `data_profile_result.inputSignature.count` SHALL be 3
- **AND** `data_profile_result.inputSignature.digest` SHALL be a stable hash over those inputs' identities, sizes, and mtimes
- **AND** `data_profile_result.profiledAt` SHALL be an ISO 8601 timestamp near the completion time

#### Scenario: Junk churn does not change the signature

- **GIVEN** two staged input sets that differ only by a partial-download temp file
- **WHEN** the signature is computed over each
- **THEN** the two digests and the two counts SHALL be equal

#### Scenario: The signature is order-independent

- **GIVEN** two enumerations of the same kept input set differing only in order
- **WHEN** the signature is computed over each
- **THEN** the two digests SHALL be equal

#### Scenario: A re-profile replaces the recorded signature

- **WHEN** the body completes again after the input set changed
- **THEN** `data_profile_result.inputSignature` SHALL describe the set the new run covered
- **AND** `data_profile_result.profiledAt` SHALL be updated to the new completion time

#### Scenario: A pre-signature snapshot is still served

- **GIVEN** a snapshot written before `inputSignature` existed, carrying `inputFileIds`
- **WHEN** a consumer reads the row
- **THEN** the row SHALL deserialize with the unknown key ignored
- **AND** the absence of `inputSignature` SHALL NOT be an error, and SHALL NOT trigger a re-profile

## REMOVED Requirements

### Requirement: Result snapshot carries the profiled input set

**Reason**: Re-profiling is push-only. No harness read path compares the signature
against a current input set, so the drift and staleness scenarios of this requirement
are false. "The result snapshot records the profiled input set" replaces it, and keeps
the signature as an audit record.
**Migration**: The embedder that changes the input set invokes the re-profile on that
edge (see "Re-profiling is invoked by the embedder, never derived on read").
