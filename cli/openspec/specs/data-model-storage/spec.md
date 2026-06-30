# data-model-storage Specification

## Purpose
The SQLite schema for the local data model — the columnar `anchors`/`projects`/`analyses` tables, the blob-free `analysis_inputs` table, the `sessions.analysis_id` link, and their indexes — defined as a single forward-only baseline migration with identity → core → FK column ordering.
## Requirements
### Requirement: Single forward-only baseline migration

The data-model schema SHALL be defined as a single `version: 1` baseline in `src/db/primary_migrations.ts` (not a separate appended migration), applied in one transaction by the existing versioned runner. Tables SHALL be declared parent-before-child so every foreign key is a backward reference. There is no prod SQLite to preserve, so the schema is consolidated rather than layered as deltas.

#### Scenario: Fresh database gets the full schema

- **WHEN** the migration runner executes against a database with no applied migrations
- **THEN** migration 1 is applied
- **AND** the `anchors`, `projects`, `analyses`, `analysis_inputs`, `sessions`, `messages`, and `parts` tables all exist

#### Scenario: Parent tables precede children

- **WHEN** the baseline SQL is read top to bottom
- **THEN** `anchors` and `projects` are declared before `analyses`, and `analyses` before `analysis_inputs`, so each FK references an already-declared table

### Requirement: Columnar entity tables (no JSON data blob)

The `anchors`, `projects`, and `analyses` tables SHALL store one typed column per entity field — NOT a single JSON `data` blob — so rows are filtered, ordered, and joined directly in SQL. Columns SHALL follow the house order: the identity triple (`id`, `created_at`, `updated_at`) first and colocated, then core data, then foreign keys last.

#### Scenario: Anchors table shape

- **WHEN** the migration has been applied
- **THEN** `anchors` has columns `id` (primary key), `created_at`, `updated_at`, `cached_path`, `marker_written`, `last_seen` — and no `data` column and no `drive_id` column

#### Scenario: Projects table shape

- **WHEN** the migration has been applied
- **THEN** `projects` has columns `id` (primary key), `created_at`, `updated_at`, `name` (`UNIQUE`), `description`, `tags` — and no `data` column and no `archived_at` column

#### Scenario: Analyses table shape and FKs

- **WHEN** the migration has been applied
- **THEN** `analyses` has columns `id`, `created_at`, `updated_at`, `name`, `slug`, `output_directory`, `anchor_id`, `project_id` in that order
- **AND** `anchor_id` is `NOT NULL` and references `anchors(id)`; `project_id` is nullable and references `projects(id)`
- **AND** there is no `data`, `goals`, `synced_analysis_id`, or `archived_at` column

### Requirement: Slug is unique within an anchor

The `analyses` table SHALL enforce `UNIQUE (anchor_id, slug)`, because outputs live at `…/analyses/<slug>/` and two analyses sharing a home anchor must not collide there.

#### Scenario: Duplicate slug within one anchor is rejected

- **WHEN** two analyses with the same `slug` are inserted under the same `anchor_id`
- **THEN** the second insert trips the `UNIQUE (anchor_id, slug)` constraint

### Requirement: Analysis inputs table without a data blob

The system SHALL create an `analysis_inputs` table whose columns are the entire row, in core → foreign-key order with no identity triple: `path TEXT NOT NULL`, `is_dir INTEGER NOT NULL DEFAULT 0`, `analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE`, and `anchor_id TEXT REFERENCES anchors(id)`. It SHALL NOT include a `data` JSON column.

#### Scenario: Analysis inputs table shape

- **WHEN** the migration has been applied
- **THEN** `analysis_inputs` has exactly the columns `path`, `is_dir`, `analysis_id`, `anchor_id`
- **AND** `anchor_id` is nullable (a raw absolute-path input belongs to no tracked anchor)
- **AND** deleting an analysis cascades to delete its input rows

### Requirement: Chat tables keep a JSON data blob with FK columns

The `sessions`, `messages`, and `parts` tables SHALL keep their application-shaped JSON `data` blob, exposing only the id and foreign-key columns: `sessions(id, data, analysis_id)`, `messages(id, data, session_id)`, `parts(id, data, session_id, message_id)`. `sessions.analysis_id` links a chat session to its analysis (one analysis, many sessions); it is nullable with no default.

#### Scenario: Sessions link to analyses by column

- **WHEN** the migration has been applied
- **THEN** `sessions` has a nullable `analysis_id` column referencing `analyses(id)`, alongside `id` and `data`
- **AND** the analysis link lives in the column, not the JSON blob

#### Scenario: Message and part cascades

- **WHEN** a session (or message) is deleted
- **THEN** its `messages` (or `parts`) cascade-delete via their FK

### Requirement: Lookup indexes

The migration SHALL create the indexes `idx_analyses_project` on `analyses(project_id)`, `idx_analyses_anchor` on `analyses(anchor_id)`, `idx_analysis_inputs_analysis` on `analysis_inputs(analysis_id)`, `idx_sessions_analysis` on `sessions(analysis_id)`, `idx_messages_session` on `messages(session_id)`, `idx_parts_message` on `parts(message_id)`, and `idx_parts_session` on `parts(session_id)`.

#### Scenario: FK lookup indexes exist

- **WHEN** the migration has been applied
- **THEN** all seven named indexes exist over their stated columns

### Requirement: Migration v3 adds provenance integrity columns

The system SHALL define a `version: 3` migration in `src/db/primary_migrations.ts` that adds `provenance_chain_hash TEXT` and `provenance_signature TEXT` columns to the `analyses` table via `ALTER TABLE`. Existing rows receive `NULL`, treated as "unsigned".

#### Scenario: Migration v3 is applied after v2

- **WHEN** the migration runner executes against a database at version 2
- **THEN** version 3 is applied
- **AND** `analyses` gains `provenance_chain_hash` and `provenance_signature` columns

#### Scenario: Column ordering follows house convention

- **WHEN** the migration adds columns
- **THEN** `provenance_chain_hash` and `provenance_signature` are added after `provenance` (core data, not FK columns)

### Requirement: DB accessors for integrity columns

The system SHALL provide `getAnalysisIntegrity(id): Result<{ chainHash: string | null, signature: string | null }, DbError>` in `src/db/primary_query.ts` and extend `updateAnalysisProvenance` in `src/db/primary_mutation.ts` to accept optional `chainHash` and `signature` parameters, writing all three columns in a single `UPDATE`.

#### Scenario: Read integrity columns

- **WHEN** `getAnalysisIntegrity(id)` is called for an analysis with stored integrity data
- **THEN** it returns the `provenance_chain_hash` and `provenance_signature` values

#### Scenario: Write provenance with integrity

- **WHEN** `updateAnalysisProvenance(id, prov, chainHash, signature)` is called
- **THEN** `provenance`, `provenance_chain_hash`, and `provenance_signature` are updated in one statement

