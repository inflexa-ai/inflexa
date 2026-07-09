# data-profile-rerun Specification

## Purpose

Define re-profiling — recomputing an analysis's data profile after its input set
changes (new files appended) — and clearance — removing the profile when the input
set empties, so consumers return honestly to "not profiled". Re-profiling is driven
by an atomic `completed → running` claim on the `data_profile_status` ledger so
concurrent re-profile triggers dedup: only one CAS UPDATE wins and starts a workflow.
The prior `data_profile_result` is deliberately preserved during the re-profile so
the API can keep serving the last profile while the new one runs. The result
snapshot records which inputs were profiled (`inputFileIds`) and when
(`profiledAt`), so staleness — files added since the last profile — is detectable
by diffing the snapshot against the current staged-input manifest.

## Requirements

### Requirement: Atomic completed → running re-profile transition

`tryRerunDataProfile(querier, analysisId)` SHALL atomically transition
`data_profile_status` from `'completed'` to `'running'` with a single
`UPDATE ... WHERE data_profile_status = 'completed'`. It SHALL set
`data_profile_started_at` to the current timestamp and clear
`data_profile_error` and `data_profile_completed_at`. It SHALL NOT clear
`data_profile_result` — the prior profile is preserved so the API can serve it
during the re-profile. It SHALL resolve to `ok(true)` when the CAS won and
`ok(false)` when it lost; losing the race stays in the ok channel, not the error
channel.

#### Scenario: Completed profile transitions to running

- **WHEN** `tryRerunDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'completed'`
- **THEN** it resolves to `ok(true)`
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

The `data_profile_result` JSONB stored by `completeDataProfile` SHALL carry, in
addition to `summary` and `files`:

- `inputFileIds: string[]` — the staged-input `fileId` of every input file that was profiled
- `profiledAt: string` — ISO 8601 timestamp of profile completion

Diffing `inputFileIds` against the current staged-input manifest reveals files
added since the last profile.

#### Scenario: Initial profile stores the input snapshot

- **WHEN** the data-profile body completes for an analysis with 3 staged input files
- **THEN** `data_profile_result.inputFileIds` SHALL contain exactly the 3 staged-input identifiers
- **AND** `data_profile_result.profiledAt` SHALL be an ISO 8601 timestamp near the completion time

#### Scenario: Re-profile updates the input snapshot

- **WHEN** the body completes again after 2 new files are appended (total 5)
- **THEN** `data_profile_result.inputFileIds` SHALL contain all 5 staged-input identifiers
- **AND** `data_profile_result.profiledAt` SHALL be updated to the new completion time

#### Scenario: Staleness detection via snapshot diff

- **WHEN** `data_profile_result.inputFileIds` has 3 entries and the staged-input manifest has 5 files
- **THEN** the 2 identifiers present in the manifest but absent from `inputFileIds` represent new unprofiled files

### Requirement: Profile clearance when the input set empties

`clearDataProfile(querier, analysisId)` SHALL null the profile ledger columns
(`data_profile_status`, `data_profile_error`, `data_profile_started_at`,
`data_profile_completed_at`, `data_profile_result`, `seed_input_file_ids`) with a
single UPDATE guarded by `data_profile_status IS DISTINCT FROM 'running'` — a live
workflow's completion write would resurrect half-cleared state, so a running profile
is never cleared and the caller re-evaluates parity after that run completes. It
SHALL resolve to `ok(true)` when a row was cleared and `ok(false)` when nothing was
(the profile is running, or no analysis-state row exists) — skipping stays in the ok
channel, not the error channel. `data_profile_status` SHALL be nullable: a NULL
status means "no profile", and `loadDataProfileStatus` SHALL return `null` for it —
deliberately indistinguishable from the analysis-state row never having existed, so
consumers have exactly one "not profiled" state. A NULL-status row SHALL be
claimable by the start transition (`tryStartDataProfile` claims the startable
states — `'pending'` or NULL — into `running`): the seed upsert's conflict branch
deliberately never rewrites profile status, so without this claim an analysis
whose inputs return after a clear could never be profiled again by any path.

#### Scenario: Clearing a completed profile

- **WHEN** `clearDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'completed'`
- **THEN** it resolves to `ok(true)`
- **AND** all six profile columns SHALL be NULL
- **AND** `loadDataProfileStatus` SHALL subsequently resolve to `null`

#### Scenario: A running profile is never cleared

- **WHEN** `clearDataProfile(querier, analysisId)` is called while `data_profile_status = 'running'`
- **THEN** it resolves to `ok(false)`
- **AND** every profile column SHALL retain its prior value

#### Scenario: Clearing without an analysis-state row

- **WHEN** `clearDataProfile(querier, analysisId)` is called for an analysis with no `cortex_analysis_state` row
- **THEN** it resolves to `ok(false)`

#### Scenario: A cleared profile can be profiled again

- **WHEN** a profile is cleared and `tryStartDataProfile(querier, analysisId)` is later called for that analysis
- **THEN** the claim resolves to `ok(true)` and `data_profile_status` SHALL be `'running'`
