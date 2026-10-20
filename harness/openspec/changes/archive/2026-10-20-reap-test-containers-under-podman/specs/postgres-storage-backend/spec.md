## ADDED Requirements

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

## REMOVED Requirements

### Requirement: The container fallback refuses to leak a container

**Reason**: The requirement named an accept-the-leak route
(`CORTEX_TEST_ALLOW_LEAKED_PG=1` with `TESTCONTAINERS_RYUK_DISABLED=true`).
Agents took it, and each run left its containers and their anonymous volumes
standing. Its premise, that ryuk does not start under podman, is
false: a privileged ryuk starts on a rootful podman machine.

**Migration**: The requirement "The container fallback starts a container only
when ryuk runs" replaces it, with no opt-out. To run the database tests, use
`bun run test:full`, or set `CORTEX_TEST_PG_URL` to a Postgres that runs. A plain
`bun test` also works when ryuk can start.
