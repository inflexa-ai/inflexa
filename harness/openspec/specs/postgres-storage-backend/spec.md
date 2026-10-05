# postgres-storage Specification

## Purpose

The harness uses Postgres for everything durable: the application `cortex_*`
tables, DBOS workflow state, and pgvector embeddings for workspace search. There
is no LibSQL, SQLite, or separate vector database.

The application tables are **thin ledgers**, not document stores — `cortex_runs`,
`cortex_step_executions`, `cortex_artifacts`, `messages`,
`cortex_working_memory`, and the plan/state tables hold identifiers,
status, and lineage. The rich payloads (step summaries, run synthesis, file
descriptions) live in the session filesystem and the pgvector index, keeping
rows small and the schema stable.

**Two isolated pools per process.** A single pod runs two distinct Postgres
workloads: long application queries (table reads, pgvector search) and DBOS
system writes (workflow status, the step-result cache, streams, send/recv,
recovery bookkeeping). They run against **separate pools** so a long-running
application query can never queue DBOS operations behind it and stall workflow
progress. The application pool is built by `createPool(config)`
(`src/lib/storage.ts`), sized via `resolveAppPoolSize` (`src/runtime/pools.ts`);
DBOS opens its own system-DB pool through `src/runtime/dbos.ts`, sized by
`DBOS_SYSTEM_POOL_SIZE`. A single shared pool was rejected — it only delays
exhaustion while keeping the same cross-contamination failure mode. A boot-time
guard (`assertConnectionBudget`, `src/runtime/connection-budget.ts`) asserts one
pod's footprint (`app + DBOS + safety margin`) fits inside Postgres
`max_connections`; fleet-level sizing is the host deployment's concern, not the
harness's.

Both pools are constructed at the composition root and threaded as constructor
deps; no module reaches for a pool ambiently, and the harness never reads env
directly — it consumes a validated `PoolConfig` the embedder maps from its own
environment.

## Requirements

### Requirement: Postgres is the durable backend

The harness SHALL use Postgres for the `cortex_*` state tables, DBOS workflow
state, and vector embeddings. No LibSQL, SQLite, or separate vector database
SHALL be constructed by the harness.

#### Scenario: Single database at runtime

- **WHEN** harness state is initialized
- **THEN** application queries use a `pg.Pool`
- **AND** DBOS uses its own pool against the configured system database

### Requirement: The app pool and the DBOS pool are isolated

The application `pg.Pool` SHALL be created by `createPool` in
`src/lib/storage.ts`. DBOS SHALL own a separate system-database pool configured
by `src/runtime/dbos.ts`. The two pools SHALL NOT be shared, so a long
application query cannot starve DBOS workflow progress.

#### Scenario: Custom query uses the shared app pool

- **WHEN** state functions are invoked
- **THEN** they receive the configured app `pg.Pool`
- **AND** no separate app pool is constructed inside state modules

#### Scenario: DBOS work is unaffected by a long app query

- **GIVEN** the app pool is saturated by long-running queries
- **WHEN** DBOS performs a system write
- **THEN** it uses its own pool and is not queued behind the app queries

### Requirement: Pool sizing is centralized and budget-checked at boot

App-pool size SHALL default to `DEFAULT_APP_POOL_SIZE` and be overridable via the
optional `DB_POOL_MAX` (parsed by `resolveAppPoolSize`); the DBOS pool size SHALL
be `DBOS_SYSTEM_POOL_SIZE`. Both constants live in `src/runtime/pools.ts`. At
boot the harness SHALL assert that `app + DBOS + safety margin` fits inside
Postgres `max_connections` and SHALL fail boot loudly when it does not.

The app pool SHALL additionally bound how long a caller waits to acquire a
connection, failing with an error once that bound is exceeded. The driver's
default is an unbounded wait, which gives a caller on a saturated pool no failure
mode at all — only an indefinite hang, indistinguishable from work still in
progress and therefore capable of stalling a caller's own in-flight guard
permanently. A bounded wait turns that silent stall into a surfaced error the
caller can degrade on.

#### Scenario: Pool size override is honored

- **WHEN** `DB_POOL_MAX` is set to a positive integer
- **THEN** the app pool uses that value as its maximum size

#### Scenario: Footprint exceeding max_connections aborts boot

- **GIVEN** the combined per-pod footprint plus safety margin exceeds `max_connections`
- **WHEN** the connection-budget guard runs
- **THEN** it throws and the process aborts boot instead of degrading under load

#### Scenario: A saturated pool fails rather than hanging

- **GIVEN** every connection in the app pool is checked out
- **WHEN** a caller requests a connection and none is released within the bound
- **THEN** the request rejects with an error rather than waiting indefinitely

### Requirement: Connection config is supplied, not read from env

The harness `createPool` SHALL consume a `PoolConfig` (host, port, database,
user, password, sslMode, optional poolMax) rather than reading environment
variables itself. The conventional mapping an embedder applies is `DB_PG_HOST`,
`DB_PG_PORT`, `DB_PG_NAME`, `DB_PG_USER`, `DB_PG_PASSWORD`, `DB_PG_SSLMODE`, and
`DB_POOL_MAX`; embedders MAY construct and pass their own pool.

#### Scenario: Embedder maps env onto PoolConfig

- **WHEN** an embedder builds the app pool
- **THEN** it maps its `DB_PG_*` / `DB_POOL_MAX` env onto a `PoolConfig` and passes it to `createPool`

### Requirement: pgvector extension is ensured on startup

The harness SHALL run `CREATE EXTENSION IF NOT EXISTS vector;` during state
initialization. If the extension cannot be created and is not already present,
startup SHALL fail with a clear error.

#### Scenario: Extension present

- **WHEN** the database has `vector` installed
- **THEN** initialization proceeds

#### Scenario: Extension cannot be created

- **WHEN** `CREATE EXTENSION IF NOT EXISTS vector` fails and the extension is absent
- **THEN** `initCortexState` raises a clear error naming the pgvector requirement

### Requirement: Test isolation via Postgres schemas

Tests that touch the database MUST use `withSchema(testName)` from
`src/__tests__/setup/postgres.ts`. Each test MUST get its own schema scoped
through `search_path`, against a `pgvector/pgvector:pg18` database.

One container serves a whole run only when `CORTEX_TEST_PG_URL` names one
Postgres. Bun gives each test file its own module state. Thus the memoized
promise in `postgres.ts` is not shared between test files. On the container
fallback each database test file starts its own container.

#### Scenario: Override via env var

- **WHEN** `CORTEX_TEST_PG_URL` is set to a running Postgres instance
- **THEN** tests use that instance instead of starting a container
- **AND** schemas are still isolated per test

#### Scenario: The container fallback starts one container for each test file

- **WHEN** `CORTEX_TEST_PG_URL` is unset, and more than one database test file runs
- **THEN** each of those files starts its own container, because the memoized promise is not shared

### Requirement: The container fallback refuses to leak a container

The container fallback MUST refuse to start a container when nothing will remove
it again. The guard is `assertContainerWillBeReaped`
(`src/__tests__/setup/require-reaper.ts`), and `startContainer` MUST call it
before it makes a container.

The guard MUST run only when `CORTEX_TEST_PG_URL` is unset. Thus a test file
that starts no container never meets the guard. A unit test is such a file.

The refusal MUST name the routes that start one container for the whole run. The
refusal MUST also name the two variables of the accept-the-leak route.
`CORTEX_TEST_ALLOW_LEAKED_PG=1` gets past the guard.
`TESTCONTAINERS_RYUK_DISABLED=true` stops `GenericContainer.start()` from a
start of ryuk on its own. Both are necessary on a host where ryuk cannot start.

#### Scenario: Ryuk is disabled

- **WHEN** `TESTCONTAINERS_RYUK_DISABLED=true`, and `CORTEX_TEST_ALLOW_LEAKED_PG` is unset
- **THEN** the guard throws, and it reaches no container runtime

#### Scenario: No container runtime is reachable

- **WHEN** `getContainerRuntimeClient()` throws
- **THEN** the guard throws, and the refusal names the cause

#### Scenario: The reaper cannot start

- **WHEN** `getReaper()` throws, as it does on a podman host
- **THEN** the guard throws, and no container is made

#### Scenario: The developer accepts the leak

- **WHEN** `CORTEX_TEST_ALLOW_LEAKED_PG` holds a value
- **THEN** the guard returns before it reads anything else, and the container starts

#### Scenario: A unit test never meets the guard

- **WHEN** a test file starts no container
- **THEN** the guard does not run, because `startContainer` is not called

### Requirement: The tool output table keeps the text of a cut tool result

`initCortexState` MUST make the table `cortex_tool_outputs` with `CREATE TABLE IF NOT EXISTS`. The table MUST hold these columns:

- `analysis_id`: the analysis of the session of the loop
- `ref`: the reference that the excerpt gives
- `tool_name` and `tool_call_id`: the call that gave the result
- `thread_id`: the thread of a chat loop, nullable, and null for a loop of a run
- `content`: the kept text
- `total_length`: the length of the whole text of the result
- `created_at`: the time of the first write

The primary key MUST be `(analysis_id, ref)`. The init MUST also make a partial index on `thread_id` for the rows where it is not null, for the delete of a thread purge.

`createToolOutputStore(pool)` in `src/state/tool-outputs.ts` MUST realize the tool output store of the loop over the application pool (refer to the harness-agent-loop capability). `put` MUST be an upsert on the primary key. A second `put` of one key MUST replace the text, and it MUST keep `created_at`. `get` MUST read one row by the analysis id and the reference, and it MUST give `null` when no row exists. A failure MUST be an `err` of `DbError`, and neither method throws.

The table holds conversation data, the same as `messages`: the text of a tool result that a model can read again. A product of an analysis stays a file of the workspace tree.

#### Scenario: A kept text round-trips

- **GIVEN** a `put` of a text of 300,000 characters that holds a character outside ASCII
- **WHEN** `get` runs with the same analysis id and reference
- **THEN** it gives the same text, byte-identical, with the same length, the same tool call id, and the same thread id

#### Scenario: A second put replaces the text

- **GIVEN** a row for one analysis id and one reference
- **WHEN** a second `put` of the same key gives a different text
- **THEN** `get` gives the second text, and `created_at` does not change

#### Scenario: A reference belongs to its analysis

- **GIVEN** a row of analysis A with the reference `to_3f9a2c41b8d605e7a1c0`
- **WHEN** `get` runs with analysis B and the same reference
- **THEN** it gives `null`

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
