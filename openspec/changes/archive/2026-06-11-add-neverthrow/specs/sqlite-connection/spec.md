## MODIFIED Requirements

### Requirement: Lazy singleton database connection
The system SHALL open a SQLite database connection lazily on first access and reuse the same connection for all subsequent calls within the process. The `db()` function SHALL return `Result<Database, DbError>` instead of `Database`. On successful initialization, the `Database` instance SHALL be cached so subsequent calls return `ok(cachedDb)` without re-initialization. On failure, the error SHALL NOT be cached — subsequent calls SHALL retry initialization.

#### Scenario: First access creates the database
- **WHEN** `db()` is called for the first time and the database opens successfully
- **THEN** the system returns `ok(database)` with a usable connection and caches the instance

#### Scenario: Subsequent access reuses connection
- **WHEN** `db()` is called after a successful initialization
- **THEN** the system returns `ok(cachedDatabase)` without opening a new connection

#### Scenario: Connection failure
- **WHEN** `db()` is called and the database cannot be opened (e.g., invalid path, permission denied)
- **THEN** the system returns `err({ type: "connection_failed", cause })` and does NOT cache the failure

#### Scenario: Retry after failure
- **WHEN** `db()` previously returned an error and is called again after the underlying issue is resolved
- **THEN** the system retries initialization and returns `ok(database)` on success
