# sqlite-connection Specification

## Purpose
The connection of the CLI to its SQLite database. The `db()` function opens the connection at the first call, applies the production PRAGMAs, runs the pending migrations, and keeps the connection for the process. A failure comes back as a `DbError` on the `Result` channel.
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
The system MUST use `agent.db` in the data root as the database path. `src/lib/env.ts` resolves the data root one time, at import, from these sources, in this order:

1. The `INFLEXA_DATA_DIR` variable.
2. The `dataDir` key of the config file.
3. `inflexa` under the data home of the platform. The data home is `XDG_DATA_HOME`, or `LOCALAPPDATA` on Windows. When that variable is not set, the data home is `~/.local/share`, or `~/AppData/Local` on Windows.

The value of `INFLEXA_DATA_DIR` and of `dataDir` is the data root itself, not a base directory. The system MUST ignore an empty value. A leading `~` is the home directory. The first value that is not empty decides. If that value is not an absolute path, each command MUST stop with an error that names the variable or the key, and MUST NOT use the next source. On Windows, each command MUST stop with an error when a value names a custom root, because the Postgres data of Windows is in a named volume and not in the data root. No variable overrides the database path alone. The system MUST make the parent directory if it does not exist.

#### Scenario: Default path
- **WHEN** `XDG_DATA_HOME`, `INFLEXA_DATA_DIR`, and `dataDir` are not set on Linux or macOS
- **THEN** the system opens the database at `~/.local/share/inflexa/agent.db`

#### Scenario: Data directory from the environment
- **WHEN** `XDG_DATA_HOME` is set to `/tmp/data`
- **THEN** the system opens the database at `/tmp/data/inflexa/agent.db`

#### Scenario: Data root from the variable
- **WHEN** `INFLEXA_DATA_DIR` is set to `/scratch/u/inflexa`, and the config file sets `dataDir` to `/data/u/inflexa`
- **THEN** the system opens the database at `/scratch/u/inflexa/agent.db`

#### Scenario: Data root from the config file
- **WHEN** `INFLEXA_DATA_DIR` is not set, and the config file sets `dataDir` to `/data/u/inflexa`
- **THEN** the system opens the database at `/data/u/inflexa/agent.db`

#### Scenario: A relative data root stops each command
- **WHEN** `INFLEXA_DATA_DIR` is set to `scratch/inflexa`
- **THEN** each command exits with status 1, and the error names `INFLEXA_DATA_DIR`

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

