# sqlite-connection Specification

## Purpose
TBD - created by archiving change raw-sqlite-db-layer. Update Purpose after archive.
## Requirements
### Requirement: Lazy singleton database connection
The system SHALL open a SQLite database connection lazily on first access and reuse the same connection for all subsequent calls within the process.

#### Scenario: First access creates the database
- **WHEN** any database function is called for the first time
- **THEN** the system creates the database file at the configured path and returns a usable connection

#### Scenario: Subsequent access reuses connection
- **WHEN** a database function is called after the connection has been established
- **THEN** the system returns the existing connection without opening a new one

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

