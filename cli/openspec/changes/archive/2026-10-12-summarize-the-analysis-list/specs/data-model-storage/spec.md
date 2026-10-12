# Spec Delta

## MODIFIED Requirements

### Requirement: Columnar entity tables (no JSON data blob)

The `anchors`, `projects`, and `analyses` tables MUST store one typed column per entity field — NOT a single JSON `data` blob — so rows are filtered, ordered, and joined directly in SQL. Columns MUST follow the house order: the identity triple (`id`, `created_at`, `updated_at`) first and colocated, then core data, then foreign keys last. A column that a later migration adds with `ALTER TABLE … ADD COLUMN` appends after the foreign keys. SQLite cannot insert a column in place, and a rebuild of a parent table cascades into its children.

#### Scenario: Anchors table shape

- **WHEN** the migration has been applied
- **THEN** `anchors` has columns `id` (primary key), `created_at`, `updated_at`, `cached_path`, `marker_written`, `last_seen` — and no `data` column and no `drive_id` column

#### Scenario: Projects table shape

- **WHEN** the migration has been applied
- **THEN** `projects` has columns `id` (primary key), `created_at`, `updated_at`, `name` (`UNIQUE`), `description`, `tags` — and no `data` column and no `archived_at` column

#### Scenario: Analyses table shape and FKs

- **WHEN** the migrations ran
- **THEN** `analyses` has columns `id`, `created_at`, `updated_at`, `name`, `slug`, `provenance`, `provenance_chain_hash`, `provenance_signature`, `provenance_prev_chain_hash`, `anchor_id`, `project_id`, `last_activity_at` in that order
- **AND** `anchor_id` is `NOT NULL` and references `anchors(id)`
- **AND** `project_id` is nullable and references `projects(id)`
- **AND** `last_activity_at` is a `NOT NULL` integer of epoch milliseconds
- **AND** there is no `data`, `goals`, `synced_analysis_id`, `archived_at`, or `output_directory` column — the workspace root is derived from anchor + slug, never stored

#### Scenario: The activity column is backfilled

- **GIVEN** an analysis row from before the activity column
- **WHEN** the migration adds the column
- **THEN** the `last_activity_at` of the row equals its `updated_at`

### Requirement: Lookup indexes

The migrations MUST leave exactly these explicitly-declared indexes:

- the FK lookup indexes `idx_analyses_project` on `analyses(project_id)`, `idx_analyses_anchor` on `analyses(anchor_id)`, and `idx_analysis_inputs_analysis` on `analysis_inputs(analysis_id)`
- `idx_analyses_activity` on `analyses(last_activity_at, id)`, which serves the activity order of the analysis list
- the two unique partial indexes that enforce input de-duplication: `uq_analysis_inputs_anchored` on `analysis_inputs(analysis_id, path, anchor_id)` where `anchor_id IS NOT NULL`, and `uq_analysis_inputs_unanchored` on `analysis_inputs(analysis_id, path)` where `anchor_id IS NULL`
- `idx_llm_usage_scope` on `llm_usage(scope_kind, scope_id)`
- `idx_ps_flight_subs_flight` on `package_store_flight_subscriptions(flight_id)`, and the two unique partial indexes `uq_ps_flight_subs_analysis` on `(flight_id, analysis_id)` where `analysis_id IS NOT NULL` and `uq_ps_flight_subs_host` on `(flight_id)` where `analysis_id IS NULL`

The chat-table indexes are dropped with their tables by migration 2. SQLite's own `sqlite_autoindex_*` entries (backing the `PRIMARY KEY`/`UNIQUE` constraints) are outside this set — they are implicit, not declared.

#### Scenario: FK lookup indexes exist

- **WHEN** all migrations have been applied
- **THEN** exactly those named indexes exist over their stated columns, and no other explicitly-declared index does
- **AND** `idx_sessions_analysis`, `idx_messages_session`, `idx_parts_message`, and `idx_parts_session` do not exist
