# sqlite-migrations Specification

## Purpose
TBD - created by archiving change raw-sqlite-db-layer. Update Purpose after archive.
## Requirements
### Requirement: Migration tracking table
The system SHALL maintain a `_migrations` table to track which migrations have been applied:

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

#### Scenario: Tracking table created on first run
- **WHEN** the migration runner executes against a fresh database
- **THEN** the `_migrations` table is created before any migrations are applied

#### Scenario: Tracking table already exists
- **WHEN** the migration runner executes against a database that already has the `_migrations` table
- **THEN** no error occurs and existing records are preserved

### Requirement: Ordered versioned migrations
Migrations SHALL be defined as an ordered array of `{ version: number, up: string }` objects. The `version` field MUST be a positive integer. Versions MUST be strictly ascending in the array.

#### Scenario: Migrations applied in order
- **WHEN** the database has no applied migrations and the array contains versions 1, 2, 3
- **THEN** migrations 1, 2, and 3 are applied in that order

#### Scenario: Only pending migrations applied
- **WHEN** the database has already applied version 1 and the array contains versions 1, 2, 3
- **THEN** only migrations 2 and 3 are applied

#### Scenario: Already up to date
- **WHEN** the database has applied all versions in the array
- **THEN** no migrations are applied and no error occurs

### Requirement: Transactional migration execution
Each migration SHALL be applied within a transaction. The version SHALL be recorded in `_migrations` with the current timestamp (milliseconds since epoch) after the migration SQL succeeds.

#### Scenario: Successful migration
- **WHEN** a migration's SQL executes without error
- **THEN** the version is recorded in `_migrations` with `applied_at` set to the current time

#### Scenario: Failed migration
- **WHEN** a migration's SQL causes an error
- **THEN** the transaction is rolled back and the version is NOT recorded in `_migrations`

### Requirement: Reusable migration runner
The migration runner function SHALL accept a `Database` instance and a migrations array, making it reusable across multiple databases (primary, queue, etc.).

#### Scenario: Runner used for primary database
- **WHEN** `runMigrations(db, primaryMigrations)` is called
- **THEN** it applies pending migrations from `primaryMigrations` to `db`

#### Scenario: Runner used for a different database
- **WHEN** `runMigrations(queueDb, queueMigrations)` is called with a different database and migration set
- **THEN** it applies pending migrations from `queueMigrations` to `queueDb` independently

