# cortex-state-layer Specification

## Purpose

Define the harness execution-state layer — the `cortex_*` application tables that
act as thin ledgers alongside the DBOS system database. The store runs on
Postgres (the `pg` driver directly) with the pgvector extension for the workspace
vector index; there is no SQLite path. App tables hold identity, status, and
reconciliation keys only — rich data (summaries, findings, file descriptions)
lives in workspace files and the vector index, not in DB columns. Schema is
created and evolved on startup via idempotent `CREATE TABLE IF NOT EXISTS` plus
additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`
migrations, serialized across replicas by a Postgres advisory lock so concurrent
startups never race on DDL.

This spec covers the two analysis-scoped tables the state layer owns:
`cortex_analysis_state` (per-analysis singleton: status, billing identity,
data-profile lifecycle) and `cortex_artifacts` (the cross-run file registry that
carries the two reconciliation keys — `artifact_id` from provenance registration
and `file_id` from upload sync).

## Requirements

### Requirement: cortex_analysis_state table schema

The `cortex_analysis_state` table SHALL store per-analysis singleton state with
the columns: `analysis_id` (TEXT, PRIMARY KEY), `status` (TEXT, NOT NULL),
`context` (TEXT, nullable), `billing_context` (JSONB, nullable),
`data_profile_status` (TEXT, **nullable**, default `'pending'`),
`data_profile_error` (TEXT, nullable), `data_profile_started_at` (TEXT,
nullable), `data_profile_completed_at` (TEXT, nullable), `data_profile_result`
(JSONB, nullable), `seed_input_file_ids` (JSONB, nullable), `created_at` (TEXT,
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

#### Scenario: Suspend and resume on budget exhaustion

- **WHEN** `suspendAnalysis` runs after a budget-exceeded error
- **THEN** `status` SHALL become `'suspended_insufficient_funds'` (idempotent),
  and `resumeAnalysis` SHALL transition it back to `'active'` only from that
  suspended state

### Requirement: cortex_artifacts table schema

The `cortex_artifacts` table SHALL store the cross-run file registry with the
columns: `analysis_id` (TEXT, NOT NULL), `path` (TEXT, NOT NULL —
analysis-relative canonical path), `hash` (TEXT, NOT NULL — SHA-256), `size`
(BIGINT, NOT NULL), `role` (TEXT, NOT NULL), `source_step` (TEXT, nullable —
null for inputs), `source_run` (TEXT, nullable — null for inputs), `artifact_id`
(TEXT, nullable — provenance entity id set after registration), `file_id` (TEXT,
nullable — object-store id set after upload sync), `created_at` (TEXT, NOT NULL),
`unrecoverable_at` (TEXT, nullable), `file_type` (TEXT, nullable). The primary
key SHALL be `(analysis_id, path)`. Indexes SHALL exist on `(analysis_id,
source_run)` and `(analysis_id, artifact_id)`.

The `role` column SHALL accept only `'input'` or `'step_output'`. `size` is
BIGINT so files larger than 2 GB do not overflow on INSERT. There SHALL be no
`legacy_artifact_id` column or `idx_cortex_artifacts_legacy` index — they do not
exist in the current schema.

#### Scenario: Input file registered at materialization

- **WHEN** an input file is registered
- **THEN** a row is inserted with `role='input'`, `source_step` and `source_run`
  NULL, `file_id` set to the upstream file identity when known, and `artifact_id`
  NULL

#### Scenario: Step output registered after execution

- **WHEN** a sandbox step completes and produces output files
- **THEN** each output file is inserted with `role='step_output'`, `source_step`
  the step id, `source_run` the run id, and `artifact_id`/`file_id` NULL

#### Scenario: Batched upsert is a single multi-row statement

- **WHEN** `upsertArtifacts(pool, entries)` registers a step's full manifest
- **THEN** it SHALL write every entry in one round-trip via a multi-row `INSERT
  ... VALUES (...), (...), ...` with `ON CONFLICT (analysis_id, path) DO UPDATE`
  (not a per-row loop and not a driver `batch()` call)

#### Scenario: Artifact id filled after provenance registration

- **WHEN** `registerStepArtifacts` registers artifacts and receives entity ids
- **THEN** `updateArtifactId(pool, resourceId, path, artifactId, fileType?)`
  SHALL set the `artifact_id` column (and coalesce `file_type`)

#### Scenario: File ids filled after upload sync

- **WHEN** the sync pass confirms uploads and receives `{ artifactId, fileId }`
  pairs
- **THEN** `updateFileIds(pool, pairs)` SHALL set each row's `file_id` in one
  `UPDATE ... FROM (VALUES ...)` statement keyed by `artifact_id`

#### Scenario: Querying a step's unsynced artifacts

- **WHEN** `queryUnsyncedStepArtifacts(pool, resourceId, runId, stepId)` is
  called
- **THEN** it SHALL return that step's rows where `artifact_id IS NOT NULL AND
  file_id IS NULL AND role = 'step_output'`, ordered by `created_at`
