## ADDED Requirements

### Requirement: Versioned migrations for the cortex tables

`initCortexState(pool)` MUST apply the pending migrations of `src/state/migrations/` with the Kysely migrator, in the order of their names. The migrator MUST record each applied migration in the table `cortex_migration`, and it MUST use the table `cortex_migration_lock`. It MUST keep the two tables in the current schema of the pool. A migration MUST NOT change after a release. A schema change MUST be a new migration, with a name that sorts after each existing name.

Each migration MUST set `lock_timeout` to 5 s for its transaction. Thus a statement that waits for a lock fails after 5 s, and it holds up the queries of the other sessions for 5 s at most.

The first migration, `20260927120000_baseline`, MUST hold only idempotent statements. Thus it applies to an empty database and to a database that an earlier harness made with its DDL at each start.

#### Scenario: Fresh database is initialized

- **WHEN** `initCortexState(pool)` runs against an empty database
- **THEN** the required tables exist with the documented indexes and types
- **AND** `cortex_migration` records the baseline

#### Scenario: A database from the DDL at each start gets the baseline

- **GIVEN** a database that an earlier harness made, with no `cortex_migration` table
- **WHEN** `initCortexState(pool)` runs
- **THEN** the baseline brings the tables to the current schema, and no row is lost
- **AND** `cortex_migration` records the baseline

#### Scenario: A start with no pending migration does not wait for a reader

- **GIVEN** a database where `cortex_migration` records each migration
- **AND** a different session holds an open transaction that read a cortex table
- **WHEN** `initCortexState(pool)` runs
- **THEN** it completes, because it runs no DDL

#### Scenario: A lock wait ends at the lock timeout

- **GIVEN** a pending migration that alters a table
- **AND** a different session holds an open transaction that read that table
- **WHEN** `initCortexState(pool)` runs
- **THEN** it fails with a lock timeout after 5 s
- **AND** `cortex_migration` records nothing, thus the next run applies the migration

## REMOVED Requirements

### Requirement: Idempotent startup DDL for cortex tables

**Reason**: The DDL took an ACCESS EXCLUSIVE lock on each table at each start, with no lock timeout. One idle transaction stopped each start, and the queries of the live replicas waited behind the queued `ALTER TABLE`.

**Migration**: The versioned migrations replace the DDL at each start. The baseline migration holds the same statements, thus an existing database gets it one time.
