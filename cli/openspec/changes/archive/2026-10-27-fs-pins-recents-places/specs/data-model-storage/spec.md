## MODIFIED Requirements

### Requirement: Lookup indexes

The migrations MUST leave exactly these explicitly-declared indexes:

- the FK lookup indexes `idx_analyses_project` on `analyses(project_id)`, `idx_analyses_anchor` on `analyses(anchor_id)`, `idx_analysis_inputs_analysis` on `analysis_inputs(analysis_id)`, and `idx_run_seen_marks_analysis` on `run_seen_marks(analysis_id)`
- `idx_analyses_activity` on `analyses(last_activity_at, id)`, which serves the activity order of the analysis list
- the two unique partial indexes that enforce input de-duplication: `uq_analysis_inputs_anchored` on `analysis_inputs(analysis_id, path, anchor_id)` where `anchor_id IS NOT NULL`, and `uq_analysis_inputs_unanchored` on `analysis_inputs(analysis_id, path)` where `anchor_id IS NULL`
- `idx_llm_usage_scope` on `llm_usage(scope_kind, scope_id)`
- `idx_ps_flight_subs_flight` on `package_store_flight_subscriptions(flight_id)`, and the two unique partial indexes `uq_ps_flight_subs_analysis` on `(flight_id, analysis_id)` where `analysis_id IS NOT NULL` and `uq_ps_flight_subs_host` on `(flight_id)` where `analysis_id IS NULL`
- `uq_picker_pins_path`, the unique index on `picker_pins(path)`
- `idx_recent_files_scope` on `recent_files(analysis_id, updated_at)`, which serves the newest-first read of one scope and the FK lookup
- the two unique partial indexes that keep one row for each path of a scope: `uq_recent_files_analysis` on `recent_files(path, analysis_id)` where `analysis_id IS NOT NULL`, and `uq_recent_files_machine` on `recent_files(path)` where `analysis_id IS NULL`

The chat-table indexes are dropped with their tables by migration 2. SQLite's own `sqlite_autoindex_*` entries (backing the `PRIMARY KEY`/`UNIQUE` constraints) are outside this set — they are implicit, not declared.

#### Scenario: FK lookup indexes exist

- **WHEN** all migrations have been applied
- **THEN** exactly those named indexes exist over their stated columns, and no other explicitly-declared index does
- **AND** `idx_sessions_analysis`, `idx_messages_session`, `idx_parts_message`, and `idx_parts_session` do not exist

## ADDED Requirements

### Requirement: The pins and the recent files of the picker

A migration MUST add two tables, with the columns in the house order:

- `picker_pins`: `id` (`TEXT PRIMARY KEY`), `created_at` and `updated_at` (`INTEGER NOT NULL`, epoch milliseconds), `path` (`TEXT NOT NULL`), `label` (`TEXT`, nullable), and `is_dir` (`INTEGER NOT NULL`).
- `recent_files`: `id` (`TEXT PRIMARY KEY`), `created_at` and `updated_at` (`INTEGER NOT NULL`, epoch milliseconds), `path` (`TEXT NOT NULL`), `is_dir` (`INTEGER NOT NULL`), and `analysis_id` (`TEXT`, nullable, referencing `analyses(id)` with `ON DELETE CASCADE`).

A pin has no analysis, because a pin is a fact of the machine. SQLite treats each `NULL` as distinct in a `UNIQUE` key, thus a partial index pair keeps one row for each path of a scope.

#### Scenario: One recent file for each path of the machine scope

- **GIVEN** a `recent_files` row of `/data/a.csv` with no analysis
- **WHEN** a second row of `/data/a.csv` with no analysis is inserted
- **THEN** the insert trips the unique constraint

#### Scenario: The recent files go with their analysis

- **GIVEN** an analysis with two `recent_files` rows
- **WHEN** its row is deleted
- **THEN** `recent_files` holds no row of that analysis
