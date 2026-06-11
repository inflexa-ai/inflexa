## MODIFIED Requirements

### Requirement: Reusable migration runner
The migration runner function SHALL accept a `Database` instance and a migrations array, making it reusable across multiple databases (primary, queue, etc.). The function SHALL return `Result<void, DbError>` instead of `void`. On failure, the error SHALL include `{ type: "migration_failed", cause }`.

#### Scenario: Runner succeeds
- **WHEN** `runMigrations(db, migrations)` is called and all migrations apply successfully
- **THEN** it returns `ok(undefined)`

#### Scenario: Runner fails on migration SQL
- **WHEN** `runMigrations(db, migrations)` is called and a migration's SQL causes an error
- **THEN** it returns `err({ type: "migration_failed", cause })` with the original error as `cause`

#### Scenario: Runner used for primary database
- **WHEN** `runMigrations(db, primaryMigrations)` is called
- **THEN** it applies pending migrations from `primaryMigrations` to `db` and returns `ok(undefined)`
