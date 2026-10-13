# Spec Delta

## ADDED Requirements

### Requirement: The seen marks of the runs

A migration MUST add two tables that record which terminal run the person saw on this machine:

- `run_seen_marks`: the columns `run_id` (`TEXT PRIMARY KEY`), `seen_at` (`INTEGER NOT NULL`, epoch milliseconds), and `analysis_id` (`TEXT NOT NULL`, referencing `analyses(id)` with `ON DELETE CASCADE`), in that order.
- `run_seen_baseline`: the one column `since` (`INTEGER NOT NULL`, epoch milliseconds). The migration MUST write one row with the time at which the migration runs.

A run lives in Postgres, thus `run_id` references no SQLite table. A terminal run that ended before `since` counts as seen with no mark. The delete of an analysis row removes its marks through the cascade.

#### Scenario: The migration writes the baseline

- **WHEN** the migration that adds the marks runs at time T
- **THEN** `run_seen_baseline` holds one row, and its `since` is T to the millisecond

#### Scenario: The marks go with their analysis

- **GIVEN** an analysis with two seen marks
- **WHEN** its row is deleted
- **THEN** `run_seen_marks` holds no mark of that analysis

## MODIFIED Requirements

### Requirement: Lookup indexes

The migrations MUST leave exactly these explicitly-declared indexes:

- the FK lookup indexes `idx_analyses_project` on `analyses(project_id)`, `idx_analyses_anchor` on `analyses(anchor_id)`, `idx_analysis_inputs_analysis` on `analysis_inputs(analysis_id)`, and `idx_run_seen_marks_analysis` on `run_seen_marks(analysis_id)`
- `idx_analyses_activity` on `analyses(last_activity_at, id)`, which serves the activity order of the analysis list
- the two unique partial indexes that enforce input de-duplication: `uq_analysis_inputs_anchored` on `analysis_inputs(analysis_id, path, anchor_id)` where `anchor_id IS NOT NULL`, and `uq_analysis_inputs_unanchored` on `analysis_inputs(analysis_id, path)` where `anchor_id IS NULL`
- `idx_llm_usage_scope` on `llm_usage(scope_kind, scope_id)`
- `idx_ps_flight_subs_flight` on `package_store_flight_subscriptions(flight_id)`, and the two unique partial indexes `uq_ps_flight_subs_analysis` on `(flight_id, analysis_id)` where `analysis_id IS NOT NULL` and `uq_ps_flight_subs_host` on `(flight_id)` where `analysis_id IS NULL`

The chat-table indexes are dropped with their tables by migration 2. SQLite's own `sqlite_autoindex_*` entries (backing the `PRIMARY KEY`/`UNIQUE` constraints) are outside this set — they are implicit, not declared.

#### Scenario: FK lookup indexes exist

- **WHEN** all migrations have been applied
- **THEN** exactly those named indexes exist over their stated columns, and no other explicitly-declared index does
- **AND** `idx_sessions_analysis`, `idx_messages_session`, `idx_parts_message`, and `idx_parts_session` do not exist
