# data-profile-launch — Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Staging precedes the trigger and the manifest rides verbatim

Every path that dispatches a data-profile workflow SHALL stage the analysis's inputs into the session
data dir first, seed the ledger with the resulting manifest, and hand that manifest to the trigger
unchanged. Staging content-hashes each file and mirrors the tree — deleting staged files no current
input produces — so it SHALL run only once a (re-)trigger has been decided, never as part of a parity
comparison.

Because tree mirroring deletes any on-disk file absent from the manifest the *calling* staging run
built, and because the harness's ledger CAS serializes only the workflow dispatch that happens *after*
staging, staging for one analysis SHALL NOT run concurrently with itself. In the CLI's single-process
model the per-analysis instance lock excludes other processes (it is re-entrant per pid, so it cannot
serve this purpose in-process); the in-process callers SHALL serialize among themselves.

The same serialization SHALL cover the ledger clear that an emptied input set performs, because
clearing nulls `seed_input_file_ids` and would otherwise be able to land between a concurrent drive's
seed write and its trigger, causing that drive to be refused for an absent seed.

#### Scenario: The manifest reaches the trigger unchanged

- **WHEN** staging returns a manifest of N files
- **THEN** the trigger receives exactly those N entries, in order, with no transform

#### Scenario: Concurrent drives do not race the staged tree

- **WHEN** two profile drives for the same analysis are requested while the first is still staging
- **THEN** the second SHALL run only after the first has completed its stage → seed → trigger sequence
- **AND** no staged input file SHALL be deleted by a run that did not enumerate it

#### Scenario: A clear cannot refuse a concurrent seed

- **WHEN** a drive observing an empty input set clears the ledger while another drive has seeded a non-empty set but not yet triggered
- **THEN** the two SHALL NOT interleave, and the seeding drive SHALL NOT be refused for a missing seed
