# data-profile-rerun Specification

## Purpose

Define re-profiling — recomputing an analysis's data profile after its input set
changes (new files appended). Re-profiling is driven by an atomic
`completed → running` claim on the `data_profile_status` ledger so concurrent
re-profile triggers dedup: only one CAS UPDATE wins and starts a workflow. The
prior `data_profile_result` is deliberately preserved during the re-profile so
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
