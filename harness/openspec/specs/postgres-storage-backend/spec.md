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

The container fallback keeps its container in the module state of
`postgres.ts`. Thus the fallback starts one container for each module registry
of Bun that runs a database test file. A registry that runs no database test
file starts no container. With the Bun that the root `.bun-version` of the
repository names, the count for each test mode is:

- `bun test`: all test files share one module registry, thus one container
  serves the whole run.
- `bun test --isolate`: each test file gets a fresh module registry, thus each
  database test file starts its own container.
- `bun test --parallel`: the option implies `--isolate`, thus each database test
  file starts its own container.
- `bun test --parallel --no-isolate`: each worker keeps one module registry,
  thus each worker that runs a database test file starts its own container.

When `CORTEX_TEST_PG_URL` names one Postgres, each mode uses that Postgres and
starts no container. That Postgres MUST be a database that no host uses (see
"The test override refuses a database that a host uses").

#### Scenario: Override via env var

- **WHEN** `CORTEX_TEST_PG_URL` is set to a running Postgres instance that no host uses
- **THEN** tests use that instance instead of starting a container
- **AND** schemas are still isolated per test

#### Scenario: A default run shares one container

- **WHEN** `CORTEX_TEST_PG_URL` is unset, and a `bun test` without `--isolate` or `--parallel` runs more than one database test file
- **THEN** the files share one container, because they share the module state of `postgres.ts`

#### Scenario: The container fallback starts one container for each test file

- **WHEN** `CORTEX_TEST_PG_URL` is unset, and `bun test --isolate` or `bun test --parallel` runs more than one database test file
- **THEN** each of those files starts its own container, because each file gets a fresh module registry

### Requirement: The test override refuses a database that a host uses

When `CORTEX_TEST_PG_URL` is set, the test setup MUST make sure that no host uses that database before the first test uses it.

The guard MUST read two schemas of the override database: `public`, and the schema that `current_schema()` gives on the base pool of the override. The base pool sets no `search_path`. A host on the same URL makes its tables in that second schema. The guard MUST refuse the database when one of the two schemas holds a relation that no extension owns. A relation here is a table, a partitioned table, a view, a materialized view, or a foreign table. An object that an extension owns MUST NOT cause a refusal, for example the objects of pgvector in `public`.

The guard MUST run before the setup installs an extension, makes a test schema, or launches DBOS. The guard MUST only read. It MUST NOT read the `dbos` schema, and it MUST NOT write a marker. Thus a run that uses one override database for each test file, under each test mode, meets a database that the guard permits again. A dedicated test database that a developer uses for more than one run stays permitted.

The refusal MUST be an error that names the host, the port, and the database, but not the password. It MUST name the relations that it found, up to a limit, and say when it omits some. It MUST name the routes that are safe:

- `bun run test:full`, with `CORTEX_TEST_PG_URL` unset first, because the script uses a set `CORTEX_TEST_PG_URL` again
- the container fallback, with `CORTEX_TEST_PG_URL` unset
- `CORTEX_TEST_PG_URL` set to a dedicated Postgres whose `public` schema is empty

The refusal MUST NOT give a database that a host uses as a safe route. The reaper guard and the documents of the harness MUST name the same dedicated Postgres for the override route.

#### Scenario: A database with host tables is refused

- **GIVEN** an override database whose `public` schema holds a table that no extension owns
- **WHEN** a database test file asks for the test pool
- **THEN** the setup throws the refusal, and the refusal names that table and the safe routes
- **AND** no test schema is made, and DBOS does not launch

#### Scenario: A host schema of the connecting role is refused

- **GIVEN** an override database where the schema of the connecting role exists and holds a table that no extension owns, and `public` is empty
- **WHEN** a database test file asks for the test pool
- **THEN** the setup throws the refusal, and the refusal names that table

#### Scenario: Objects of an extension are permitted

- **GIVEN** an override database whose `public` schema holds only objects that an extension owns, a relation of the extension included
- **WHEN** a database test file asks for the test pool
- **THEN** the guard permits the database

#### Scenario: A test database that earlier files used is permitted

- **GIVEN** an override database where earlier test files of the run or of an earlier run made test schemas and the `dbos` schema
- **WHEN** a later database test file asks for the test pool, also under `--isolate` or `--parallel`
- **THEN** the guard permits the database

#### Scenario: The container fallback does not meet the guard

- **WHEN** `CORTEX_TEST_PG_URL` is unset
- **THEN** the override guard does not run, because the fallback starts its own empty database

### Requirement: The test setup installs pgvector in `public`

The test setup MUST install the pgvector extension in the `public` schema of the test database. Each test pool searches only its test schema and `public`. The setup MUST name `public` as the schema of the install, thus the default schema of the connecting role does not decide the location.

When the extension already exists in a schema other than `public`, the setup MUST throw an error before it makes a test schema. The error MUST name the database with the same label as the refusal of the dedicated-database guard, and it MUST NOT name the password. The error MUST name the schema that holds the extension. It MUST name the remedies: move the extension to `public`, use `bun run test:full` with `CORTEX_TEST_PG_URL` unset, or use a new dedicated database. The setup MUST NOT move or drop an extension that it did not install.

The dedicated-database guard runs before this install (see "The test override refuses a database that a host uses").

#### Scenario: A schema of the connecting role exists

- **GIVEN** a test database with no pgvector, where a schema with the name of the connecting role exists
- **WHEN** the setup installs pgvector
- **THEN** the extension is in `public`
- **AND** a pool whose `search_path` is a test schema and `public` resolves the type `vector`

#### Scenario: The extension is already in a different schema

- **GIVEN** a test database where pgvector is installed in a schema other than `public`
- **WHEN** a database test file asks for the test pool
- **THEN** the setup throws an error that names that schema, the database, and the remedy
- **AND** the extension stays in that schema, and no test schema is made

#### Scenario: The extension is already in `public`

- **GIVEN** a test database where pgvector is installed in `public`
- **WHEN** a database test file asks for the test pool
- **THEN** the setup continues, and the test pool resolves the type `vector`

### Requirement: The container fallback starts a container only when ryuk runs

The container fallback MUST refuse to start a container when nothing will remove
it again. The guard is `assertContainerWillBeReaped`
(`src/__tests__/setup/require-reaper.ts`), and `startContainer` MUST call it
before it makes a container.

The guard MUST run only when `CORTEX_TEST_PG_URL` is unset. Thus a test file
that starts no container never meets the guard. A unit test is such a file.

The guard MUST have no opt-out. No variable lets the fallback start a container
without a running reaper.

Before the guard starts the reaper, it MUST set
`TESTCONTAINERS_RYUK_PRIVILEGED=true` when that variable is absent from the
environment. On a rootful podman machine, SELinux in the VM blocks the runtime
socket for an unprivileged ryuk, and a privileged ryuk starts. The guard MUST
keep each value that the developer set, the empty value included.

The refusal MUST name the routes that start one container for the whole run. The
refusal MUST also name the variables that let ryuk start on a podman machine:

- `DOCKER_HOST`, for a host where `/var/run/docker.sock` does not reach the
  machine
- `TESTCONTAINERS_RYUK_PRIVILEGED=true`
- `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`, for a machine whose runtime socket
  inside the VM is not at `/var/run/docker.sock`, for example a rootless machine

The refusal MUST NOT name a route that starts a container without a reaper.

#### Scenario: Ryuk is disabled

- **WHEN** `TESTCONTAINERS_RYUK_DISABLED=true`, whatever other variable is set
- **THEN** the guard throws, and it reaches no container runtime

#### Scenario: No container runtime is reachable

- **WHEN** `getContainerRuntimeClient()` throws
- **THEN** the guard throws, and the refusal names the cause

#### Scenario: The reaper cannot start

- **WHEN** `getReaper()` throws
- **THEN** the guard throws, no container is made, and the refusal names the podman variables

#### Scenario: Ryuk runs privileged when the developer set nothing

- **WHEN** `TESTCONTAINERS_RYUK_PRIVILEGED` is absent from the environment, and the guard is about to start the reaper
- **THEN** the guard sets `TESTCONTAINERS_RYUK_PRIVILEGED=true` first

#### Scenario: The value of the developer stays

- **WHEN** `TESTCONTAINERS_RYUK_PRIVILEGED` holds a value, the empty value included
- **THEN** the guard keeps that value

#### Scenario: A plain run on a rootful podman machine removes its containers

- **WHEN** `bun test` runs a database test file on a rootful podman machine, and `CORTEX_TEST_PG_URL` and the testcontainers variables are unset
- **THEN** ryuk starts, and after the process exits ryuk removes the container, its anonymous volume, and itself

#### Scenario: A unit test never meets the guard

- **WHEN** a test file starts no container
- **THEN** the guard does not run, because `startContainer` is not called

### Requirement: The full-suite script removes its container

`bun run test:full` (`scripts/test-full.sh`) MUST remove the container that it
starts, and the anonymous volume of that container, when the script exits. The
script MUST arm its removal before it starts the container. Thus an interrupt at
any point after the start of the script removes the container.

#### Scenario: The suite ends

- **WHEN** `bun test` under the script passes or fails
- **THEN** the script removes its container and the anonymous volume of the container

#### Scenario: An interrupt stops the script

- **WHEN** the script gets SIGINT or SIGTERM, also while `docker run` starts the container
- **THEN** the script removes its container and the anonymous volume of the container

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

`initCortexState(pool)` MUST apply the pending migrations of `src/state/migrations/` with the Kysely migrator, in the order of their names. The migrator MUST record each applied migration in the table `cortex_migration`, and it MUST use the table `cortex_migration_lock`. It MUST keep the two tables in the current schema of the pool.

A migration MUST NOT change after a release. A schema change MUST be a new migration, with a name that sorts after each existing name. A step that keeps data is the one exception to these rules, as this requirement describes below. The migrator MUST refuse a pending name that sorts before an applied name.

Each migration MUST set `lock_timeout` to 5 s for its transaction. Thus a statement that waits for a lock fails after 5 s, and it holds up the queries of the other sessions for 5 s at most.

The first migration, `20260927120000_baseline`, MUST hold only idempotent statements. Thus it applies to an empty database and to a database that an earlier harness made with its DDL at each start.

The tables, the columns, and the values that the migrations give in the current schema MUST NOT depend on a different schema of the database. A test schema shares its database with other test schemas, and a host database can hold a test schema from an earlier run. A probe of the catalog in a migration MUST read only `current_schema()`. A released migration that reads more than the current schema stays as it is, and a later migration MUST repair its result.

A later migration cannot restore a value that a released migration removed. Thus, when a released migration removes a value of the current schema because it reads a different schema, a step can keep that value. Only this case permits the step. The step MUST run before the code of the released migration, under its recorded name, in the same transaction. The step MUST read and write only the current schema, and it MUST change only what is necessary to keep the value. The code of the released migration MUST stay the same, thus a database that recorded the released migration runs nothing new.

The released migration `20261029120000_reference_the_run_mandate` has such a step. When the current schema holds `mandate_jti` and no `mandate_id`, the step adds `mandate_id` and copies each value of `mandate_jti` into it.

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

#### Scenario: A different schema with the mandate reference does not remove it from a new schema

- **GIVEN** a schema of the database whose `cortex_runs` holds `mandate_id`
- **WHEN** `initCortexState(pool)` runs against a new, empty schema of the same database
- **THEN** `cortex_runs` of the new schema holds `mandate_id`, and it holds no `mandate_jti` and no `mandate_expires_at`

#### Scenario: A different schema with the mandate reference does not remove the values of an old schema

- **GIVEN** a schema of the database whose `cortex_runs` holds `mandate_id`
- **AND** a second schema whose `cortex_runs` holds `mandate_jti` with a value, and whose `cortex_migration` does not record `20261029120000_reference_the_run_mandate`
- **WHEN** `initCortexState(pool)` runs against the second schema
- **THEN** `cortex_runs` of the second schema holds `mandate_id` with that value
- **AND** it holds no `mandate_jti` and no `mandate_expires_at`

#### Scenario: A schema that lost the mandate reference gets the column again

- **GIVEN** a schema whose `cortex_migration` records `20261029120000_reference_the_run_mandate` and does not record `20261112120000_add_the_run_mandate_column_again`
- **AND** the `cortex_runs` of that schema holds no `mandate_id`
- **WHEN** `initCortexState(pool)` runs against that schema
- **THEN** `cortex_runs` of that schema holds `mandate_id`
