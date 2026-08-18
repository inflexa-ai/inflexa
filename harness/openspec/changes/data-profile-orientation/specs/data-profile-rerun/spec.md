## ADDED Requirements

### Requirement: A profile that covered little of its input set is not reported as fresh

The result snapshot SHALL carry the profile's coverage — how many staged files the profile
assigned to a kind, against how many were staged — and `inspect_data_profile` SHALL surface
it.

Coverage is a distinct failure from drift and today is invisible. A profile that classified
a small fraction of its inputs has the same `inputFileIds` as one that classified all of
them, so the staleness predicate reports it `completed` and fresh, nothing re-triggers it,
and the shortfall is discoverable only by reading the profile.

Coverage SHALL NOT by itself drive an automatic re-profile. Some input sets legitimately
resist classification, and a predicate that re-triggered on low coverage would re-profile
them on every parity check.

#### Scenario: A partial profile reports its coverage

- **GIVEN** a profile that assigned 49 of 3513 staged files to a kind
- **WHEN** a consumer reads the profile
- **THEN** it SHALL be able to establish both figures from the snapshot

#### Scenario: Low coverage does not loop

- **GIVEN** a completed profile with low coverage and an unchanged input set
- **WHEN** the embedder applies the profiling policy
- **THEN** it SHALL NOT re-trigger profiling on coverage alone

## MODIFIED Requirements

### Requirement: Result snapshot carries the profiled input set

The `data_profile_result` JSONB stored by `completeDataProfile` SHALL carry, in addition to the
profiler's full output (the dataset classification, the kinds and axes, and the notable-file
records — see the data-profile-init spec):

- `inputSignature: { count: number; digest: string }` — the comparand identifying *which* files
  a profile covered and *whether the same bytes* were profiled. `count` is the number of staged
  inputs; `digest` is a stable hash over the staged inputs' identities and their per-file size
  and mtime, computed in a canonical order so the value depends on the set and not on
  enumeration order.
- `profiledAt: string` — ISO 8601 timestamp of profile completion

A consumer SHALL detect drift by computing the same signature over a freshly enumerated input
set at stat cost and comparing it against `inputSignature`.

`inputFileIds: string[]` and `inputFiles: { fileId, size, mtimeMs }[]` SHALL remain readable and
SHALL be optional on read. A snapshot written before `inputSignature` existed carries one or both,
and a consumer SHALL fall back to comparing them; a snapshot carrying `inputSignature` need not
carry either. A snapshot carrying neither a signature nor an id list SHALL be treated as drift
(re-profiling heals it), exactly as a null `result` already is.

Storing the full identity list is what the signature replaces. Its only consumer was this
comparison, so a set of several thousand identifiers was persisted, detoasted on every read of the
row, and compared element-wise to answer a question a fixed-width digest answers — while the
"audit record of which files a profile covered" the list was described as providing was read by
nothing.

The signature deliberately excludes the content hash: enumerating it would require reading every input
in full on every parity check, which is the cost the hash-free enumeration path exists to avoid. An
edit that preserves both byte length and mtime is therefore not detected — a bounded, documented
limitation.

#### Scenario: Initial profile stores the input signature

- **WHEN** the data-profile body completes for an analysis with 3 staged input files
- **THEN** `data_profile_result.inputSignature.count` SHALL be 3
- **AND** `data_profile_result.inputSignature.digest` SHALL be a stable hash over those inputs' identities, sizes, and mtimes
- **AND** `data_profile_result.profiledAt` SHALL be an ISO 8601 timestamp near the completion time

#### Scenario: The signature is order-independent

- **GIVEN** two enumerations of the same input set differing only in order
- **WHEN** the signature is computed over each
- **THEN** the two digests SHALL be equal

#### Scenario: A changed input set is detected

- **GIVEN** a completed profile carrying an input signature
- **WHEN** a file is added to the analysis and the signature is recomputed
- **THEN** the digests SHALL differ and the profile SHALL be reported stale

#### Scenario: A legacy snapshot still compares

- **GIVEN** a snapshot written before `inputSignature` existed, carrying `inputFileIds`
- **WHEN** a consumer evaluates staleness
- **THEN** it SHALL fall back to comparing the identity list rather than treating the snapshot as drift
