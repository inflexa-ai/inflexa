## MODIFIED Requirements

### Requirement: Single forward-only baseline migration

The data-model schema SHALL be defined as the `version: 1` baseline in `src/db/primary_migrations.ts` plus subsequent forward-only versioned migrations, each applied in one transaction by the existing versioned runner. The baseline SHALL remain byte-stable (it keeps creating the historical chat tables so already-applied histories replay identically); migration `version: 2` SHALL drop the legacy chat tables (`sessions`, `messages`, `parts`) — a deliberate deletion of frozen legacy transcript rows that are unreachable from any surface. Tables SHALL be declared parent-before-child so every foreign key is a backward reference.

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
- **THEN** every table appears before any table that references it

### Requirement: Lookup indexes

The migrations SHALL leave exactly the indexes `idx_analyses_project` on `analyses(project_id)`, `idx_analyses_anchor` on `analyses(anchor_id)`, and `idx_analysis_inputs_analysis` on `analysis_inputs(analysis_id)`; the chat-table indexes are dropped with their tables by migration 2.

#### Scenario: FK lookup indexes exist

- **WHEN** all migrations have been applied
- **THEN** the three named indexes exist over their stated columns
- **AND** `idx_sessions_analysis`, `idx_messages_session`, `idx_parts_message`, and `idx_parts_session` do not exist

## REMOVED Requirements

### Requirement: Chat tables keep a JSON data blob with FK columns

**Reason**: The `sessions`, `messages`, and `parts` tables are dropped — session identity is single-homed in the harness Postgres thread store (`cortex_analysis_threads.analysis_id` carries the analysis link), and the SQLite transcripts have been frozen legacy since the pg thread became authoritative.
**Migration**: Migration `version: 2` drops the three tables; the analysis↔session one-to-many survives as `listThreads({analysisId})` on the thread store.
