## ADDED Requirements

### Requirement: An analysis with no input files completes without a workflow

`completeEmptyDataProfile(querier, analysisId)` MUST stamp a row `'completed'` with a single
UPDATE. The guard MUST be `data_profile_status IS DISTINCT FROM 'running' AND
(seed_input_file_ids IS NULL OR jsonb_array_length(seed_input_file_ids) = 0)`. The write MUST
set `data_profile_started_at` and `data_profile_completed_at` to one timestamp, because no
workflow ran. The write MUST set `data_profile_error`, `data_profile_result`, and
`data_profile_workflow_id` to NULL. The write MUST set `seed_input_file_ids` to `[]`, so that
the completed row names the set that it covers.

The operation MUST resolve to `ok(true)` when it stamped the row. It MUST resolve to `ok(false)`
when the guard refused the row: no such analysis, a live run, or a seed that names files. A
refusal stays in the ok channel.

The seed predicate is the negation of the claim conjunct. Thus a claim into `running` and an
empty-set completion can never both win on one row. A seed upsert that lands between a caller's
pre-read and the stamp is never hidden behind a finished profile.

A `completed` row whose seed is `[]` MUST NOT be claimable by `tryRerunDataProfile`. A later seed
upsert that names files makes the row claimable. Then the rerun claim MUST take it as any
completed row.

#### Scenario: A never-profiled row with no seed completes at once

- **WHEN** `completeEmptyDataProfile(querier, analysisId)` is called for a row whose `data_profile_status` is NULL and whose `seed_input_file_ids` is NULL
- **THEN** it MUST resolve to `ok(true)`
- **AND** `data_profile_status` MUST be `'completed'`
- **AND** `data_profile_result` and `data_profile_workflow_id` MUST be NULL
- **AND** `seed_input_file_ids` MUST be `[]`
- **AND** `data_profile_started_at` MUST equal `data_profile_completed_at`

#### Scenario: A prior profile whose files are gone is replaced

- **WHEN** `completeEmptyDataProfile` is called for a `'completed'` row with a stored `data_profile_result` and a seed of `[]`
- **THEN** it MUST resolve to `ok(true)` and `data_profile_result` MUST be NULL

#### Scenario: A live run is never stamped

- **WHEN** `completeEmptyDataProfile` is called while `data_profile_status = 'running'`
- **THEN** it MUST resolve to `ok(false)` and every profile column MUST keep its prior value

#### Scenario: A seed that names files refuses the stamp

- **WHEN** `completeEmptyDataProfile` is called for a row whose `seed_input_file_ids` names at least one file
- **THEN** it MUST resolve to `ok(false)` and the row MUST be untouched

#### Scenario: A completed-empty row is claimable for a rerun after a reseed

- **WHEN** a seed upsert names files on a `'completed'` row whose seed was `[]`, and `tryRerunDataProfile` is then called
- **THEN** it MUST resolve to `ok(true)` and `data_profile_status` MUST be `'running'`

### Requirement: The trigger completes an analysis with no input files at once

When `stagedInputs` is empty and the seed is NULL or `[]`, `triggerDataProfile` MUST call
`completeEmptyDataProfile`. When the stamp landed, the trigger MUST return `"completed"`. The
trigger MUST attempt no claim into `'running'`, and it MUST start no workflow. When the stamp
refused the row and the row is `'running'`, the trigger MUST return `"already_running"`. In every
other refusal the trigger MUST return `"failed"` and log the rejection with the analysis id.

`DataProfileTriggerResult` MUST carry the member `"completed"`.

#### Scenario: A never-profiled analysis with no inputs is completed

- **WHEN** `triggerDataProfile` runs with an empty `stagedInputs` for an analysis whose `seed_input_file_ids` is NULL
- **THEN** it MUST return `"completed"`
- **AND** `data_profile_status` MUST be `'completed'` with a NULL `data_profile_result` and a seed of `[]`
- **AND** no workflow MUST be started

#### Scenario: An analysis seeded with an empty set is completed

- **WHEN** `triggerDataProfile` runs with an empty `stagedInputs` for an analysis whose `seed_input_file_ids` is `[]`
- **THEN** it MUST return `"completed"` and `data_profile_status` MUST be `'completed'`

#### Scenario: An empty manifest against a live run reports the run

- **WHEN** `triggerDataProfile` runs with an empty `stagedInputs` while `data_profile_status = 'running'` and the seed names no file
- **THEN** it MUST return `"already_running"` and the row MUST be untouched

#### Scenario: An empty manifest for a missing analysis row fails

- **WHEN** `triggerDataProfile` runs with an empty `stagedInputs` for an analysis with no `cortex_analysis_state` row
- **THEN** it MUST return `"failed"`

## MODIFIED Requirements

### Requirement: The trigger rejects an unseeded analysis before dispatch

`triggerDataProfile` MUST return `"failed"` without a claim when `stagedInputs` names at least
one file and the seed is NULL or empty. The trigger MUST log the rejection with the analysis id.
When `stagedInputs` is empty and the seed names at least one file, the trigger MUST also return
`"failed"` without a claim. The caller and the ledger diverge in that case. This pre-read is the
source of the operator-facing reason. The CAS conjuncts of the claims and of the empty-set
completion are the enforcement.

#### Scenario: An unseeded analysis is refused before any claim

- **WHEN** `triggerDataProfile` runs with a `stagedInputs` that names a file, for an analysis whose `seed_input_file_ids` is NULL
- **THEN** it MUST return `"failed"`
- **AND** the ledger row MUST be untouched (no transition to `'running'` is attempted)

#### Scenario: An analysis seeded with an empty set is refused a manifest that names files

- **WHEN** `triggerDataProfile` runs with a `stagedInputs` that names a file, for an analysis whose `seed_input_file_ids` is `[]`
- **THEN** it MUST return `"failed"` and the ledger row MUST be untouched

#### Scenario: An empty manifest against a seed that names files is refused

- **WHEN** `triggerDataProfile` runs with an empty `stagedInputs` for an analysis whose `seed_input_file_ids` names at least one file
- **THEN** it MUST return `"failed"` and the ledger row MUST be untouched
