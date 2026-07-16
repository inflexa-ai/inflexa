## ADDED Requirements

### Requirement: The engine connection is configurable

`DockerClientConfig` and `CreateSandboxClientConfig` SHALL carry an optional
`engineSocketPath: string` — the unix socket of the Docker-API engine the
backend dials (a Docker daemon socket or a podman Docker-compat socket).
`createSandboxClient` SHALL thread it to `createDockerSandboxOps`, which SHALL
construct its `dockerode` client against that socket. When unset, construction
SHALL preserve dockerode's default resolution (`DOCKER_HOST`, then the default
Docker socket), so existing embedders observe no behavior change. The injected
test instance (`docker?:`) SHALL keep taking precedence over any configured
socket path. Podman is a *connection* to this backend, not a separate backend:
`backend` stays `"docker" | "k8s"` and `SandboxRef.backend: "docker"` continues
to mean "the Docker API".

#### Scenario: Sandboxes are created against a configured engine socket

- **GIVEN** `engineSocketPath` set to a podman Docker-compat socket
- **WHEN** `createSandboxClient` builds the docker backend and a sandbox is created
- **THEN** every engine call (create, start, inspect, list, remove) dials that socket
- **AND** the returned `SandboxRef` carries `backend: "docker"` unchanged

#### Scenario: Unset engine socket preserves default resolution

- **GIVEN** no `engineSocketPath`
- **WHEN** the docker backend is constructed
- **THEN** the dockerode client is constructed with no connection options, resolving `DOCKER_HOST` or the default Docker socket exactly as before

### Requirement: Step-tree access mode for engines with honest bind ownership

`CreateSandboxClientConfig` SHALL carry an optional
`stepTreeAccess: "world-writable"`. When set, the client SHALL `chmod` the
pre-created step write tree — the step directory and each of its
`STEP_SUBDIRS` — world-writable after creating it, so the uid-1000 sandbox
workload can write through engines whose bind mounts preserve host ownership
(podman machine's virtiofs presents the embedder user's real uid and modes;
Docker Desktop's file-sharing layer masks the mismatch, which is why default
modes suffice there). The mode SHALL be applied with an explicit `chmod`, not
`mkdir`'s mode option (which the process umask masks), and SHALL be applied on
replay when the directories already exist. When unset, pre-creation SHALL keep
today's default modes. The loosening is scoped to the step write tree only:
read-only mounts (analysis tree, lib/ref stores) rely on standard world-read
and SHALL NOT be relabeled or re-moded.

#### Scenario: World-writable step tree under a podman connection

- **GIVEN** `stepTreeAccess: "world-writable"`
- **WHEN** `createSandbox` pre-creates the step tree
- **THEN** the step directory and its subdirectories are world-writable
- **AND** a workload write from uid 1000 through the read-write bind succeeds

#### Scenario: Replayed pre-creation still applies the mode

- **GIVEN** `stepTreeAccess: "world-writable"` and a step tree left by a prior attempt with default modes
- **WHEN** `createSandbox` runs again for the same step
- **THEN** the existing directories are re-moded world-writable rather than skipped

#### Scenario: Default modes when unset

- **GIVEN** no `stepTreeAccess`
- **WHEN** `createSandbox` pre-creates the step tree
- **THEN** directory modes are the process default, unchanged from today

## MODIFIED Requirements

### Requirement: Container creation is idempotent on a recovery re-run

`createSandbox` SHALL be idempotent on the checkpointed `sandboxId`. When
`createContainer` fails for any reason, the backend SHALL inspect the container
under the checkpointed name rather than matching an engine-specific conflict
status: Docker answers a name collision with HTTP 409, podman's compat API
answers 500, and the reconciliation MUST NOT depend on either. If a container
stands under the name, the owner-guard applies: it is adopted or replaced only
when its `cortex/owner-workflow-id` label equals `meta.childWorkflowId`. A
running owned container is adopted as-is; a stopped owned container is removed
and recreated; a container owned by a different step is refused with a
`name_conflict` error. If no container stands under the name, the failure was
not a name collision and the backend SHALL return the **original create
error** — the inspect's own failure is never surfaced. The decision and its
rationale are owned by the harness-sandbox-exec spec.

#### Scenario: Running container adopted on recovery re-run

- **GIVEN** a failed create whose existing container is running and labeled with the same `cortex/owner-workflow-id`
- **WHEN** `createSandbox` reconciles it
- **THEN** the existing container is adopted without recreation and its health is re-verified

#### Scenario: Foreign owner is refused

- **GIVEN** a failed create whose existing container is labeled with a different `cortex/owner-workflow-id`
- **WHEN** `createSandbox` reconciles it
- **THEN** it returns a `name_conflict` error and neither adopts nor removes the container

#### Scenario: Adoption works on an engine that answers name conflicts with 500

- **GIVEN** an engine that rejects a duplicate-name create with HTTP 500 and a running container owned by this workflow standing under the checkpointed name
- **WHEN** `createSandbox` retries after a recovery
- **THEN** the standing container is adopted exactly as it would be after a Docker 409

#### Scenario: A non-conflict create failure is returned unchanged

- **GIVEN** a create that fails while no container stands under the checkpointed name
- **WHEN** `createSandbox` inspects the name and finds nothing
- **THEN** it returns the original `container_create_failed` error, not the inspect's 404
