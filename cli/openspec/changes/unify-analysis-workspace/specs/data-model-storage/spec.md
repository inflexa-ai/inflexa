# data-model-storage Delta

## MODIFIED Requirements

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

### Requirement: Provenance integrity columns in the baseline schema

The `version: 1` baseline in `src/db/primary_migrations.ts` SHALL declare four provenance columns on the `analyses` table — `provenance TEXT`, `provenance_chain_hash TEXT`, `provenance_signature TEXT`, and `provenance_prev_chain_hash TEXT` — in that order. There is no separate `ALTER TABLE` / `version: 2` / `version: 3` migration; the columns exist from the first migration. Per the house column order they sit as core data: after `slug` and before the `anchor_id`/`project_id` foreign keys. A row has `NULL` in all four until its first signed flush.

#### Scenario: Baseline creates all four provenance columns

- **WHEN** the migration runner executes against a fresh database
- **THEN** migration 1 is applied and `analyses` has `provenance`, `provenance_chain_hash`, `provenance_signature`, and `provenance_prev_chain_hash` columns
- **AND** the `_migrations` ledger records exactly `[1]`

#### Scenario: Column ordering follows house convention

- **WHEN** the baseline SQL is read
- **THEN** the four provenance columns appear after `slug` (core data) and before `anchor_id`/`project_id` (foreign keys)
