## MODIFIED Requirements

### Requirement: cortex_analysis_state table schema

The `cortex_analysis_state` table SHALL store per-analysis singleton state with
the columns: `analysis_id` (TEXT, PRIMARY KEY), `status` (TEXT, NOT NULL),
`context` (TEXT, nullable), `billing_context` (JSONB, nullable),
`data_profile_status` (TEXT, **nullable**, default `'pending'`),
`data_profile_error` (TEXT, nullable), `data_profile_started_at` (TEXT,
nullable), `data_profile_completed_at` (TEXT, nullable), `data_profile_result`
(JSONB, nullable), `data_profile_workflow_id` (TEXT, nullable),
`seed_input_file_ids` (JSONB, nullable), `created_at` (TEXT,
NOT NULL), `updated_at` (TEXT, NOT NULL).

`billing_context` SHALL hold the billing-attribution headers (`Record<string,
string>`) as JSONB and is nullable — the OSS no-op billing path leaves it null.
The `data_profile_status` column SHALL accept `'pending'`, `'running'`,
`'completed'`, and `'failed'`; `'running'` covers both initial profiling and
re-profiling, the distinction being made at the API layer by the presence of
`data_profile_result`. It SHALL also accept NULL, which means "no profile" —
`clearDataProfile` writes it when an analysis's input set empties (see the
data-profile-rerun spec), and startup SHALL drop the legacy NOT NULL constraint
from databases created before the column became nullable.

`data_profile_workflow_id` SHALL hold the DBOS workflow id of the profile attempt
that owns the row, written by the workflow body rather than by the trigger — the
ledger claim happens before the workflow id is minted, so only the body can report
the id of the attempt that actually started. The write SHALL be conditional on the
row still being `running`, so a late write cannot stamp an id onto a settled row.

Every claim into `running` SHALL clear the column, and `clearDataProfile` SHALL clear
it too. The claim is the moment a new attempt takes the row, so any id already there
belongs to a finished attempt: left in place it would leave a `running` row naming a
stream that has already drained, and a consumer would subscribe and observe nothing
with no way to distinguish that from a profile yet to report. NULL says "not
addressable yet", which is exactly true until the new body records its own id. This
is deliberately asymmetric with `data_profile_result`, which a re-profile claim
preserves: the result is content that stays valid until replaced, while the id is a
pointer to a live stream.

The column is nullable, and absence is a
normal state with two ordinary causes: a row claimed whose body has not yet
recorded its id, and a row written before the column existed. Both read back as
"this profile's stream is not addressable", which is true in each case. A consumer
resolves which durable event stream carries an analysis's profile activity from
this column, and SHALL NOT reconstruct it by pattern-matching workflow ids in
durability-engine tables (see the data-profile-observation spec).

The `data_profile_result` JSONB SHALL hold the profiler's full output, not a
summary of it: the dataset-level classification (`summary`, `domain`, `subtype`,
`organism` with its taxon id and confidence, `tissue`, `cellType`, `condition`,
`accessions`, `experimentalDesign`, `qualityAssessment`) and the per-file records
(`path`, `description`, `dataType`, `format`, `rows`, `cols`, `tags`, `warnings`,
`metrics`), alongside `inputFileIds`, `inputFiles`, and `profiledAt`. This row is
the profile's only durable home — no profile file exists on disk — so the
projection into it is total (see the data-profile-init spec). Every field past
`summary`/`files`/`inputFileIds`/`profiledAt` SHALL be optional on read, so a
snapshot written before the record was widened still renders.

The table SHALL NOT have a `user_id` column — user identity is derived from the
ambient credential's JWT `sub` claim at request time (the legacy `user_id` column
is dropped on startup).

#### Scenario: Analysis upserted without user_id column

- **WHEN** an analysis is created via `upsertAnalysis(pool, resourceId, context,
  billingContext, inputFileIds?)`
- **THEN** a row is inserted with `status` `'active'`, `context` and
  `billing_context` from the arguments, `data_profile_status` `'pending'`, and
  `seed_input_file_ids` set from `inputFileIds` when supplied
- **AND** no `user_id` column exists on the table

#### Scenario: Re-upsert replaces mutable fields

- **WHEN** `upsertAnalysis` is called again for an existing analysis
- **THEN** `context`, `billing_context`, and `updated_at` SHALL be replaced, and
  `seed_input_file_ids` SHALL be coalesced (kept when the new value is null)

#### Scenario: Data profile completed with input snapshot

- **WHEN** `completeDataProfile` runs after the data-profile task succeeds
- **THEN** `data_profile_status` SHALL become `'completed'` and
  `data_profile_result` SHALL be set with the profiler's full output — the
  dataset classification and the per-file records — alongside `inputFileIds`,
  `inputFiles`, and `profiledAt`

#### Scenario: Re-run preserves the prior profile result

- **WHEN** a re-profile is claimed for a completed analysis via
  `tryRerunDataProfile` (or a retry of a failed analysis via
  `tryRetryDataProfile`)
- **THEN** `data_profile_status` SHALL transition to `'running'`,
  `data_profile_started_at` SHALL be refreshed, `data_profile_error` and
  `data_profile_completed_at` SHALL be cleared, and `data_profile_result` SHALL
  retain its prior value (NOT cleared)

#### Scenario: The profile workflow id is recorded by the body and read back

- **WHEN** a data-profile workflow body runs its first durable step
- **THEN** `data_profile_workflow_id` SHALL hold that workflow's DBOS id
- **AND** the data-profile status read SHALL expose it as `workflowId`

#### Scenario: A re-profile replaces the recorded workflow id

- **WHEN** a new profile attempt claims a row that already recorded a prior
  attempt's workflow id
- **THEN** the claim SHALL clear `data_profile_workflow_id`, so the row never names a
  finished attempt while it is `running`
- **AND** `data_profile_workflow_id` SHALL become the new attempt's id once that
  attempt's body records it

#### Scenario: A settled row keeps its recorded id

- **WHEN** a profile reaches `completed` or `failed`
- **THEN** `data_profile_workflow_id` SHALL retain the id of the attempt that produced
  it, so a consumer can still address that profile's drained stream
- **AND** only a subsequent claim or clear SHALL remove it

#### Scenario: A settled row is not stamped by a late write

- **GIVEN** a profile row whose status is `completed` or `failed`
- **WHEN** a workflow-id write for that analysis is attempted
- **THEN** the row is unchanged, because the write requires a `running` status

#### Scenario: A row predating the column reads back without one

- **WHEN** the data-profile status is read for a row written before
  `data_profile_workflow_id` existed
- **THEN** `workflowId` SHALL be null and the read SHALL otherwise succeed
  unchanged

#### Scenario: Suspend and resume on budget exhaustion

- **WHEN** `suspendAnalysis` runs after a budget-exceeded error
- **THEN** `status` SHALL become `'suspended_insufficient_funds'` (idempotent),
  and `resumeAnalysis` SHALL transition it back to `'active'` only from that
  suspended state
