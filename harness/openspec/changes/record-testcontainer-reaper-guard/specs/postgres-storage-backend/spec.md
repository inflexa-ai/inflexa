## MODIFIED Requirements

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

## ADDED Requirements

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
