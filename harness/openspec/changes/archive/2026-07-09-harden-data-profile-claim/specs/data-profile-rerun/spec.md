# data-profile-rerun — Delta

## ADDED Requirements

### Requirement: A running profile always names a non-empty seeded input set

Every ledger transition into `'running'` SHALL claim a row only when `seed_input_file_ids` is a
non-empty JSON array. This applies to `tryStartDataProfile`, `tryRerunDataProfile`, and
`tryRetryDataProfile` alike.
The predicate SHALL live in the CAS `UPDATE ... WHERE` clause, so that "a `running` row records the
input set it is profiling" is an invariant of the ledger rather than a property of any one caller's
read-then-write sequence. A NULL seed and an empty (`[]`) seed SHALL be treated identically as
"unseeded".

A caller MAY additionally pre-read the seed column to produce a precise operator message, but such a
pre-read SHALL NOT be the enforcement: between a pre-read and a claim, `clearDataProfile` can null the
seed of any non-`running` row, so a claim guarded only by a pre-read can create a `running` row with
no recorded input set.

#### Scenario: A NULL seed refuses the start claim

- **WHEN** `tryStartDataProfile(querier, analysisId)` is called for a row whose `data_profile_status` is `'pending'` and whose `seed_input_file_ids` is NULL
- **THEN** it SHALL resolve to `ok(false)`
- **AND** `data_profile_status` SHALL remain `'pending'`

#### Scenario: An empty seed array refuses the start claim

- **WHEN** `tryStartDataProfile(querier, analysisId)` is called for a row whose `seed_input_file_ids` is `[]`
- **THEN** it SHALL resolve to `ok(false)`
- **AND** the row SHALL be untouched

#### Scenario: A clear racing a claim cannot produce a seedless running row

- **WHEN** `clearDataProfile` nulls a row's status and seed after a caller's seed pre-read observed a non-empty seed, and that caller then invokes `tryStartDataProfile`
- **THEN** the claim SHALL resolve to `ok(false)`
- **AND** no row SHALL exist with `data_profile_status = 'running'` and a NULL or empty `seed_input_file_ids`

#### Scenario: The rerun and retry claims carry the same conjunct

- **WHEN** `tryRerunDataProfile` is called for a `'completed'` row, or `tryRetryDataProfile` for a `'failed'` row, and in either case `seed_input_file_ids` is NULL or `[]`
- **THEN** the claim SHALL resolve to `ok(false)` and the row SHALL be untouched

### Requirement: The trigger rejects an unseeded analysis before dispatch

`triggerDataProfile` SHALL return `"failed"` without attempting a claim when the analysis's
`seed_input_file_ids` is NULL or empty, and SHALL log the rejection naming the analysis. This
pre-check is the source of the operator-facing reason; the CAS conjunct of the preceding requirement
is the enforcement.

#### Scenario: An unseeded analysis is refused before any claim

- **WHEN** `triggerDataProfile` runs for an analysis whose `seed_input_file_ids` is NULL
- **THEN** it SHALL return `"failed"`
- **AND** the ledger row SHALL be untouched (no transition to `'running'` is attempted)

#### Scenario: An analysis seeded with an empty set is refused

- **WHEN** `triggerDataProfile` runs for an analysis whose `seed_input_file_ids` is `[]`
- **THEN** it SHALL return `"failed"` and the ledger row SHALL be untouched

## MODIFIED Requirements

### Requirement: Atomic completed → running re-profile transition

`tryRerunDataProfile(querier, analysisId)` SHALL atomically transition `data_profile_status` from
`'completed'` to `'running'` with a single `UPDATE ... WHERE data_profile_status = 'completed' AND
seed_input_file_ids IS NOT NULL AND jsonb_array_length(seed_input_file_ids) > 0`. It SHALL set
`data_profile_started_at` to the current timestamp and clear `data_profile_error` and
`data_profile_completed_at`. It SHALL NOT clear `data_profile_result` — the prior profile is preserved
so the API can serve it during the re-profile. It SHALL resolve to `ok(true)` when the CAS won and
`ok(false)` when it lost or the row was unseeded; neither losing the race nor an unseeded row is an
error, both stay in the ok channel.

#### Scenario: Completed profile transitions to running

- **WHEN** `tryRerunDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'completed'` and a non-empty `seed_input_file_ids`
- **THEN** it SHALL resolve to `ok(true)`
- **AND** `data_profile_status` SHALL be `'running'`
- **AND** `data_profile_started_at` SHALL be updated
- **AND** `data_profile_error` and `data_profile_completed_at` SHALL be NULL
- **AND** `data_profile_result` SHALL retain its prior value

#### Scenario: Race condition — two concurrent re-profile triggers

- **WHEN** two callers invoke `tryRerunDataProfile()` concurrently for the same analysis
- **THEN** exactly one SHALL resolve to `ok(true)`
- **AND** the other SHALL resolve to `ok(false)`

#### Scenario: Non-completed status is a no-op

- **WHEN** `tryRerunDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'running'`
- **THEN** it SHALL resolve to `ok(false)`
- **AND** the status SHALL remain `'running'`

### Requirement: Result snapshot carries the profiled input set

The `data_profile_result` JSONB stored by `completeDataProfile` SHALL carry, in addition to `summary`
and `files`:

- `inputFileIds: string[]` — the staged-input `fileId` of every input file that was profiled. This is
  the audit record of *which* files a profile covered.
- `inputFiles: { fileId: string; size: number; mtimeMs: number }[]` — the per-file **drift signature**
  of every input file that was profiled, in the same order. This answers *whether the same bytes* were
  profiled, which `inputFileIds` cannot: a `fileId` is derived from the input's anchor and path, so an
  in-place content edit leaves it unchanged.
- `profiledAt: string` — ISO 8601 timestamp of profile completion

A consumer SHALL detect drift by comparing `inputFiles` against a freshly enumerated signature set at
stat cost. `inputFiles` SHALL be optional on read: a result written before this requirement carries
only `inputFileIds`, and a consumer SHALL treat its absence as drift (re-profiling heals it), exactly
as it already treats a null `result`.

The signature deliberately excludes the content hash: enumerating it would require reading every input
in full on every parity check, which is the cost the hash-free enumeration path exists to avoid. An
edit that preserves both byte length and mtime is therefore not detected — a bounded, documented
limitation.

#### Scenario: Initial profile stores the input snapshot and its signatures

- **WHEN** the data-profile body completes for an analysis with 3 staged input files
- **THEN** `data_profile_result.inputFileIds` SHALL contain exactly the 3 staged-input identifiers
- **AND** `data_profile_result.inputFiles` SHALL contain exactly 3 entries, each carrying the file's `fileId`, `size`, and `mtimeMs`
- **AND** `data_profile_result.profiledAt` SHALL be an ISO 8601 timestamp near the completion time

#### Scenario: Re-profile updates the input snapshot

- **WHEN** the body completes again after 2 new files are appended (total 5)
- **THEN** `data_profile_result.inputFileIds` SHALL contain all 5 staged-input identifiers
- **AND** `data_profile_result.inputFiles` SHALL carry 5 signatures
- **AND** `data_profile_result.profiledAt` SHALL be updated to the new completion time

#### Scenario: Staleness detection via snapshot diff

- **WHEN** `data_profile_result.inputFileIds` has 3 entries and the staged-input manifest has 5 files
- **THEN** the 2 identifiers present in the manifest but absent from `inputFileIds` represent new unprofiled files

#### Scenario: An in-place content edit is drift

- **WHEN** an input file's bytes change at the same path, altering its `size` or `mtimeMs`
- **THEN** its signature SHALL differ from the one recorded in `data_profile_result.inputFiles`
- **AND** a consumer comparing signature sets SHALL observe drift even though the `fileId` set is unchanged

#### Scenario: A result predating the signature field reads as drift

- **WHEN** a consumer reads a completed `data_profile_result` that carries `inputFileIds` but no `inputFiles`
- **THEN** it SHALL treat the profile as drifted and re-profile, rather than assuming parity

### Requirement: Profile clearance when the input set empties

`clearDataProfile(querier, analysisId)` SHALL null the profile ledger columns
(`data_profile_status`, `data_profile_error`, `data_profile_started_at`, `data_profile_completed_at`,
`data_profile_result`, `seed_input_file_ids`) with a single UPDATE guarded by `data_profile_status IS
DISTINCT FROM 'running'` — a live workflow's completion write would resurrect half-cleared state, so a
running profile is never cleared and the caller re-evaluates parity after that run completes. It SHALL
resolve to `ok(true)` when a row was cleared and `ok(false)` when nothing was (the profile is running,
or no analysis-state row exists) — skipping stays in the ok channel, not the error channel.
`data_profile_status` SHALL be nullable: a NULL status means "no profile", and `loadDataProfileStatus`
SHALL return `null` for it — deliberately indistinguishable from the analysis-state row never having
existed, so consumers have exactly one "not profiled" state.

A NULL-status row SHALL be claimable by the start transition — `tryStartDataProfile` claims the
startable states (`'pending'` or NULL) into `running` — because the seed upsert's conflict branch
deliberately never rewrites profile status, so without this claim an analysis whose inputs return
after a clear could never be profiled again by any path. That claim SHALL nonetheless remain subject
to the seed conjunct: because `clearDataProfile` nulls the seed alongside the status, a cleared row
becomes claimable only once a later seed upsert has repopulated `seed_input_file_ids`.

#### Scenario: Clearing a completed profile

- **WHEN** `clearDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'completed'`
- **THEN** it SHALL resolve to `ok(true)` and every profile ledger column SHALL be NULL

#### Scenario: A cleared row is not claimable until it is reseeded

- **WHEN** `tryStartDataProfile` is called for a row `clearDataProfile` just nulled, before any seed upsert has run
- **THEN** it SHALL resolve to `ok(false)` (the status is claimable, the seed is not)

#### Scenario: A cleared-then-reseeded row is claimable

- **WHEN** a seed upsert repopulates `seed_input_file_ids` on a NULL-status row and `tryStartDataProfile` is then called
- **THEN** it SHALL resolve to `ok(true)` and `data_profile_status` SHALL be `'running'`
