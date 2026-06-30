# postgres-storage Specification

## Purpose

The harness uses Postgres for everything durable: the application `cortex_*`
tables, DBOS workflow state, and pgvector embeddings for workspace search. There
is no LibSQL, SQLite, or separate vector database.

The application tables are **thin ledgers**, not document stores — `cortex_runs`,
`cortex_step_executions`, `cortex_artifacts`, `cortex_target_assessments`,
`messages`, `cortex_working_memory`, and the plan/state tables hold identifiers,
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

#### Scenario: Pool size override is honored

- **WHEN** `DB_POOL_MAX` is set to a positive integer
- **THEN** the app pool uses that value as its maximum size

#### Scenario: Footprint exceeding max_connections aborts boot

- **GIVEN** the combined per-pod footprint plus safety margin exceeds `max_connections`
- **WHEN** the connection-budget guard runs
- **THEN** it throws and the process aborts boot instead of degrading under load

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

### Requirement: Idempotent startup DDL for cortex tables

`initCortexState(pool)` SHALL execute idempotent DDL on startup to create and
migrate the thin-ledger tables it owns (`cortex_*`, `messages`,
`cortex_working_memory`) via `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS`.

#### Scenario: Fresh database is initialized

- **WHEN** `initCortexState(pool)` is called against an empty database
- **THEN** the required tables exist with the documented indexes and types

#### Scenario: Re-running init is a no-op

- **WHEN** `initCortexState(pool)` runs twice against the same database
- **THEN** the second call does not error
- **AND** no data is lost

### Requirement: Test isolation via Postgres schemas

Tests that touch the database SHALL use `withSchema(testName)` from
`src/__tests__/setup/postgres.ts`. Each test SHALL get its own schema scoped via
`search_path`, against a single `pgvector/pgvector:pg18` container reused across
the run.

#### Scenario: Override via env var

- **WHEN** `CORTEX_TEST_PG_URL` is set to a running Postgres instance
- **THEN** tests use that instance instead of starting a container
- **AND** schemas are still isolated per test
