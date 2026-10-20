## MODIFIED Requirements

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
starts no container.

#### Scenario: Override via env var

- **WHEN** `CORTEX_TEST_PG_URL` is set to a running Postgres instance
- **THEN** tests use that instance instead of starting a container
- **AND** schemas are still isolated per test

#### Scenario: A default run shares one container

- **WHEN** `CORTEX_TEST_PG_URL` is unset, and a `bun test` without `--isolate` or `--parallel` runs more than one database test file
- **THEN** the files share one container, because they share the module state of `postgres.ts`

#### Scenario: The container fallback starts one container for each test file

- **WHEN** `CORTEX_TEST_PG_URL` is unset, and `bun test --isolate` or `bun test --parallel` runs more than one database test file
- **THEN** each of those files starts its own container, because each file gets a fresh module registry
