# data-model-storage Specification

## Purpose
The SQLite schema for the local data model — the columnar `anchors`/`projects`/`analyses` tables, the blob-free `analysis_inputs` table, and their indexes — defined as a forward-only migration history (v1 baseline plus versioned deltas) with identity → core → FK column ordering. Chat/session state lives in the harness Postgres thread store, not here.
## Requirements

### Requirement: Single forward-only baseline migration


The data-model schema SHALL be defined as the `version: 1` baseline in `src/db/primary_migrations.ts` plus subsequent forward-only versioned migrations, each applied in one transaction by the existing versioned runner. The baseline SHALL remain byte-stable (it keeps creating the historical chat tables so already-applied histories replay identically); migration `version: 2` SHALL drop the legacy chat tables (`sessions`, `messages`, `parts`) — the rows become permanently unreachable (their storage is freed for reuse, not scrubbed). Tables SHALL be declared parent-before-child so every foreign key is a backward reference.

#### Scenario: Fresh database ends without chat tables

- **WHEN** the migration runner executes against a database with no applied migrations
- **THEN** migrations 1 and 2 are applied in order
- **AND** the `anchors`, `projects`, `analyses`, and `analysis_inputs` tables exist
- **AND** the `sessions`, `messages`, and `parts` tables do not exist

#### Scenario: Existing database drops the chat tables

- **WHEN** the runner executes against a database whose latest applied migration is 1
- **THEN** migration 2 drops `sessions`, `messages`, and `parts` (and their indexes) in one transaction

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
- **THEN** `analyses` has columns `id`, `created_at`, `updated_at`, `name`, `slug`, `provenance`, `provenance_chain_hash`, `provenance_signature`, `provenance_prev_chain_hash`, `anchor_id`, `project_id` in that order
- **AND** `anchor_id` is `NOT NULL` and references `anchors(id)`; `project_id` is nullable and references `projects(id)`
- **AND** there is no `data`, `goals`, `synced_analysis_id`, `archived_at`, or `output_directory` column — the workspace root is derived from anchor + slug, never stored

### Requirement: Slug is unique within an anchor


The `analyses` table SHALL enforce `UNIQUE (anchor_id, slug)`, because the analysis workspace — staged inputs, run artifacts, reports, and provenance exports — lives at `<anchorPath>/.inflexa/analyses/<slug>/`, and two analyses sharing a home anchor must not collide there. The constraint is also what makes the harness workspace-root resolver realization injective.

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

### Requirement: Lookup indexes


The migrations SHALL leave exactly five explicitly-declared indexes: the FK lookup indexes `idx_analyses_project` on `analyses(project_id)`, `idx_analyses_anchor` on `analyses(anchor_id)`, and `idx_analysis_inputs_analysis` on `analysis_inputs(analysis_id)`, plus the two unique partial indexes that enforce input de-duplication — `uq_analysis_inputs_anchored` on `analysis_inputs(analysis_id, path, anchor_id)` where `anchor_id IS NOT NULL`, and `uq_analysis_inputs_unanchored` on `analysis_inputs(analysis_id, path)` where `anchor_id IS NULL`. The chat-table indexes are dropped with their tables by migration 2. SQLite's own `sqlite_autoindex_*` entries (backing the `PRIMARY KEY`/`UNIQUE` constraints) are outside this count — they are implicit, not declared.

#### Scenario: FK lookup indexes exist

- **WHEN** all migrations have been applied
- **THEN** exactly those five named indexes exist over their stated columns, and no other explicitly-declared index does
- **AND** `idx_sessions_analysis`, `idx_messages_session`, `idx_parts_message`, and `idx_parts_session` do not exist

### Requirement: Provenance integrity columns in the baseline schema


The `version: 1` baseline in `src/db/primary_migrations.ts` SHALL declare four provenance columns on the `analyses` table — `provenance TEXT`, `provenance_chain_hash TEXT`, `provenance_signature TEXT`, and `provenance_prev_chain_hash TEXT` — in that order. There is no separate `ALTER TABLE` / `version: 2` / `version: 3` migration; the columns exist from the first migration. Per the house column order they sit as core data: after `slug` and before the `anchor_id`/`project_id` foreign keys. A row has `NULL` in all four until its first signed flush.

#### Scenario: Baseline creates all four provenance columns

- **WHEN** the migration runner executes against a fresh database
- **THEN** migration 1 is applied and `analyses` has `provenance`, `provenance_chain_hash`, `provenance_signature`, and `provenance_prev_chain_hash` columns
- **AND** the `_migrations` ledger records migration 1 (followed by the later versioned migrations)

#### Scenario: Column ordering follows house convention

- **WHEN** the baseline SQL is read
- **THEN** the four provenance columns appear after `slug` (core data) and before `anchor_id`/`project_id` (foreign keys)

### Requirement: DB accessors for integrity columns


The system SHALL provide `getAnalysisIntegrity(id): Result<AnalysisIntegrity | null, DbError>` in `src/db/primary_query.ts`, where `AnalysisIntegrity` carries all four integrity columns — `{ provenance, prevChainHash, chainHash, signature }`, each `string | null` — read in a single query (the verifier's one DB round-trip); an unknown id resolves to `null` on the ok channel. `updateAnalysisProvenance(id, provenance, chainHash, signature)` in `src/db/primary_mutation.ts` SHALL require all three values (unsigned provenance is never written) and persist them in a single `UPDATE` that atomically rotates the chain — copying the current `provenance_chain_hash` into `provenance_prev_chain_hash` before the new values land — returning rows changed.

#### Scenario: Read integrity columns

- **WHEN** `getAnalysisIntegrity(id)` is called for an analysis with stored integrity data
- **THEN** it returns `provenance`, `provenance_prev_chain_hash`, `provenance_chain_hash`, and `provenance_signature` from one query
- **AND** an unknown id yields `ok(null)`, not an error

#### Scenario: Write provenance with integrity

- **WHEN** `updateAnalysisProvenance(id, prov, chainHash, signature)` is called
- **THEN** `provenance`, `provenance_chain_hash`, and `provenance_signature` are updated and `provenance_prev_chain_hash` receives the prior chain hash, all in one statement
