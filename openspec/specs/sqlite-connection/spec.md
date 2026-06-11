# sqlite-connection Specification

## Purpose
TBD - created by archiving change raw-sqlite-db-layer. Update Purpose after archive.
## Requirements
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

### Requirement: Database path configuration
The system SHALL use `~/.local/share/inf/agent.db` as the default database path, overridable via the `INF_DB_PATH` environment variable. The system SHALL create parent directories if they do not exist.

#### Scenario: Default path
- **WHEN** `INF_DB_PATH` is not set
- **THEN** the database is created at `~/.local/share/inf/agent.db`

#### Scenario: Custom path via environment variable
- **WHEN** `INF_DB_PATH` is set to `/tmp/test.db`
- **THEN** the database is created at `/tmp/test.db`

#### Scenario: Parent directory creation
- **WHEN** the database path's parent directory does not exist
- **THEN** the system creates the parent directory before opening the database

### Requirement: Production PRAGMAs on connection
The system SHALL execute the following PRAGMAs in order on every new connection:

1. `PRAGMA journal_mode = WAL` — enable write-ahead logging for concurrent reads during writes
2. `PRAGMA synchronous = NORMAL` — reduce fsyncs while remaining safe under WAL
3. `PRAGMA busy_timeout = 5000` — wait up to 5 seconds instead of returning SQLITE_BUSY
4. `PRAGMA cache_size = -64000` — use ~64MB of page cache
5. `PRAGMA foreign_keys = ON` — enforce foreign key constraints

#### Scenario: PRAGMAs applied on fresh connection
- **WHEN** a new database connection is opened
- **THEN** all five PRAGMAs are applied before any query or migration runs

### Requirement: Migrations run on connection setup
The system SHALL run pending migrations after PRAGMAs are applied and before the connection is returned for use.

#### Scenario: Migrations run before first query
- **WHEN** the database connection is established for the first time
- **THEN** all pending migrations are applied before any application query can execute

