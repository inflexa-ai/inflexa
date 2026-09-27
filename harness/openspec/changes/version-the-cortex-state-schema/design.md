## Context

`initCortexState` (`src/state/init.ts`) ran the whole schema DDL at each start, under the advisory lock `cortex_state_init`. The statements are idempotent, but an idempotent `ALTER TABLE` still takes an ACCESS EXCLUSIVE lock. No statement had a lock timeout. Three hosts call the init: Cortex in Kubernetes, the CLI in its process, and the tests in one schema for each test.

## Decisions

### The Kysely migrator applies the migrations

The migrator takes migrations as code. Thus the CLI, which is one compiled binary, reads no migration directory at runtime. The migrator keeps its tables in a named schema, it serializes concurrent runs with a session-level advisory lock, and it runs the pending migrations in one transaction. `kysely` has no runtime dependency.

### The tables of the migrator have Cortex names

The migrator uses `cortex_migration` and `cortex_migration_lock`, thus an operator can see that the tables belong to Cortex. The init gives `current_schema()` as the schema of the two tables. Without a schema, the migrator finds its tables in any schema, and a test schema would see the tables of a different test schema.

### Each migration sets a lock timeout of 5 s

The init wraps each migration. The wrapper sets `lock_timeout` for the transaction before the migration runs. A queued `ALTER TABLE` thus holds up the queries of the other sessions for 5 s at most. The migrator sets its own timeout for its advisory lock only, and that setting ends with its statement.

### The baseline holds the full DDL

The baseline keeps each statement idempotent, thus it applies to an empty database and to a database from the DDL at each start. The message backfill runs in the baseline, in the same transaction. The HNSW index runs after a savepoint. If pgvector cannot build it, the baseline rolls back to the savepoint, logs a warning, and continues, as the init did before.

### The start still runs the migrator

`bootHarness` calls `initCortexState`, which applies the pending migrations. When no migration is pending, the run reads `cortex_migration` and takes no lock on a Cortex table. A host that runs the migrator before its process, for example in an init container, thus gets a start that changes nothing.
