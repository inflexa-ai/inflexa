# docker-sandbox-provider Specification

## Purpose

Defines the Docker backend for the harness `SandboxClient` — the
`createDockerSandboxOps` factory (`harness/src/sandbox/docker-client.ts`) used
for local development. Sandbox-server runs in a Docker container on the dev
host; the harness talks to it over `127.0.0.1:{mappedPort}` — the poll transport
(default) pulls results over that same loopback port, while the opt-in callback
transport has the sandbox POST HMAC callbacks back over the host network. The
factory is a thin `dockerode` wrapper: it produces only the backend-specific ops
(`createSandbox`, `teardown`, `teardownById`, `isAlive`, `listManagedSandboxes`);
the submit/await halves are backend-agnostic and shared with the K8s backend.

Container creation is **idempotent on the checkpointed sandbox id** so a DBOS
workflow recovery re-run does not orphan or duplicate a machine: the container
is named by `sandboxId`, and a name collision — whatever status the engine
answers it with (Docker 409, podman's compat API 500) — is reconciled by an
owner-guard rather than blindly recreated. The decision and its rationale are
owned by the harness-sandbox-exec spec; this spec describes the Docker-side
realization. The factory dials the engine over a configurable unix socket, so
"Docker" here means the Docker API: a podman compat socket serves equally.

Cleanup is sweep-based, not lifecycle-coupled: every managed container carries
`app.kubernetes.io/managed-by=cortex`, and a scheduled reaper
(`registerSandboxReaper`, `harness/src/sandbox/reaper.ts`) lists them via
`listManagedSandboxes` and tears down those whose owning workflow is terminal or
gone. There is no GPU passthrough on the Docker backend — GPU scheduling is a
K8s-only concern.
## Requirements
### Requirement: createDockerSandboxOps implements the backend ops

`createDockerSandboxOps` SHALL produce the backend-specific ops (`createSandbox`,
`teardown`, `teardownById`, `isAlive`, `listManagedSandboxes`) consumed by
`createSandboxClient` (`harness/src/sandbox/create-sandbox.ts`). The submit/await
halves (`submitExec`, `awaitExec`) are backend-agnostic — Docker and K8s share
the same submit + recv contract. Every op SHALL return a `ResultAsync` carrying
a `SandboxError` variant on failure, never throw.

#### Scenario: Backend selection routes to Docker in dev

- **GIVEN** `SANDBOX_BACKEND=docker`
- **WHEN** `createSandboxClient(...)` is constructed
- **THEN** the returned client wires `createDockerSandboxOps` for sandbox create/teardown
- **AND** `submitExec` / `awaitExec` are used unchanged across backends

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

### Requirement: Container lifecycle via the Docker API

`createDockerSandboxOps.createSandbox(meta, identity)` SHALL create a Docker
container from `meta.image ?? config.image` with bind mounts, CPU/memory limits,
env vars, and dynamic port mapping (`0:8765`). It SHALL start the container,
retrieve the mapped host port, and poll the sandbox-server `/health` endpoint
until it responds 200 (default 30s budget). `teardown(ref)` and
`teardownById(sandboxId)` SHALL stop and remove the container, treating a 404
(already gone) as idempotent success.

#### Scenario: Container starts and becomes healthy

- **WHEN** `createSandbox(meta, identity)` is called
- **THEN** a Docker container named `identity.sandboxId` is created and started
- **AND** the mapped host port is retrieved via the Docker API
- **AND** the sandbox-server `/health` endpoint is polled until it responds 200
- **AND** the returned `SandboxRef` carries `host: "127.0.0.1"` and the mapped port

#### Scenario: Container yields no mapped port

- **WHEN** `createSandbox` finds no host port mapped for `8765/tcp` after start
- **THEN** it stops and removes the container and returns a `container_create_failed` error

#### Scenario: Health check timeout

- **WHEN** sandbox-server does not respond 200 to `/health` within the timeout
- **THEN** `createSandbox` returns a `container_create_failed` error including the last failure detail

### Requirement: Transport-mode container wiring

`createSandbox` SHALL render the harness `SandboxTransport` into the container's
runtime configuration:

- It SHALL pass `SANDBOX_TRANSPORT` (`poll` | `callback`) into the container env in
  both modes, and pass `SANDBOX_CALLBACK_SECRET` in both modes.
- In **poll mode** it SHALL create the container on the default bridge with
  `CapAdd: ["NET_ADMIN", "SETUID", "SETGID", "SETPCAP"]` and set the Docker-poll
  firewall env flag, so the image's root entrypoint installs the egress-deny
  firewall and then de-privileges to the workload uid. It SHALL NOT set
  `CORTEX_BASE_URL`.
- In **callback mode** it SHALL set `CORTEX_BASE_URL` to the host callback ingress,
  SHALL NOT add any capability, and SHALL NOT set the firewall flag (egress is
  permitted); no `--internal` network and no gateway sidecar are created.

The workload posture SHALL be otherwise unchanged (uid 1000, `no-new-privileges`);
the added capabilities exist solely for the root entrypoint's privileged setup —
`NET_ADMIN` to install the firewall rules, `SETUID`/`SETGID` for the `setpriv`
drop to the workload uid/gid, and `SETPCAP` to clear the bounding set — and every
one of them SHALL be dropped before the workload runs, leaving the workload's
capability sets empty.

#### Scenario: Poll mode adds the egress firewall

- **GIVEN** the transport is `poll`
- **WHEN** `createSandbox` creates the container
- **THEN** the container env SHALL carry `SANDBOX_TRANSPORT=poll` and the firewall flag
- **AND** the `HostConfig` SHALL add exactly `NET_ADMIN`, `SETUID`, `SETGID`, and `SETPCAP`
- **AND** no `CORTEX_BASE_URL` SHALL be set

#### Scenario: Callback mode permits egress with no gateway

- **GIVEN** the transport is `callback`
- **WHEN** `createSandbox` creates the container
- **THEN** the container env SHALL carry `SANDBOX_TRANSPORT=callback` and `CORTEX_BASE_URL`
- **AND** the `HostConfig` SHALL NOT add any capability and SHALL NOT set the firewall flag
- **AND** no `--internal` network and no gateway container SHALL be created

### Requirement: Image source is config default overridden per step

The Docker backend SHALL use `meta.image` when the workflow supplies a per-step
image override, falling back to the `config.image` default otherwise. There is
no `SANDBOX_IMAGE` env read in this layer.

#### Scenario: Per-step image override wins

- **GIVEN** `config.image` is `sandbox-base:latest` and `meta.image` is `sandbox-base:pinned`
- **WHEN** the container is created
- **THEN** the container image is `sandbox-base:pinned`

### Requirement: Farm resolution comes before the container

When `libStorePath` is configured, `createSandbox` MUST resolve the farm
source before any container work. A resolver throw and an `unavailable`
result MUST refuse the call with the `farm_unavailable` `SandboxError`
variant. The reason of the embedder MUST ride in the error. When the
resolved farm fails the `inflexa.lock` gate, the backend MUST drop both
store mounts, log a warning, and still make the container. The sandbox
then reports the store as unavailable.

#### Scenario: A resolver refusal carries the embedder reason

- **GIVEN** a `per-analysis` farm source whose resolver returns `unavailable` with "the store download is in progress"
- **WHEN** `createSandbox` runs
- **THEN** the call returns a `farm_unavailable` error that carries that reason, and no container is made

#### Scenario: An unusable farm degrades the sandbox

- **GIVEN** a resolved farm whose `inflexa.lock` does not parse
- **WHEN** `createSandbox` runs
- **THEN** the backend makes the container with no `/mnt/libs` mount and no farm mount, and a warning is logged

### Requirement: Bind mounts replace PVCs

The Docker backend MUST bind-mount host directories into the container per
the shared mount plan (`mount-plan.ts`):

- the analysis workspace tree, a flat read-only mount at the plan's
  `readonlyTreePath`
- the per-step writable artifact root, a nested read-write mount at the
  plan's `writableStepPath`, omitted for a read-only sandbox
- the package store at `/mnt/libs`, read-only, when `libStorePath` is
  configured
- the farm of the analysis at the farm container path, read-only, from
  the resolved farm source
- the ref store at `/mnt/refs`, read-only, when `refStorePath` is configured

The farm bind MUST come after the store bind in the bind array, thus the
nesting is stable. Mount host-path sources MUST derive from the resolved
workspace root (`resolveWorkspaceRoot(analysisId)`), not from a global
session base. Each mount's read-only flag is set explicitly in the bind
string.

`buildMountPlan` MUST return only the paths both backends share — container
paths, step subdirs, and env. The K8s `subPath` strings MUST come from
`buildSessionSubPaths(coords, workspaceSubPath)`, because they are a property
of how one backend addresses a volume, not of the container contract.

#### Scenario: Workspace tree mounted read-only

- **GIVEN** an analysis whose workspace root resolves to `{workspaceRoot}`
- **WHEN** the backend makes the container
- **THEN** `{workspaceRoot}` is bind-mounted at the plan's read-only tree path (`/{analysisId}`) with the `:ro` flag

#### Scenario: Library store bind mount

- **GIVEN** a configured `libStorePath` and a resolved farm
- **WHEN** the backend makes the container
- **THEN** the container has a read-only bind at `/mnt/libs` and a read-only farm bind at the farm container path
- **AND** the sandbox env injects the lib-store path variables from the mount plan

### Requirement: Declared host-preserved bind ownership loosens the step write tree

`CreateSandboxClientConfig` SHALL carry an optional
`engineBindOwnership: "host-preserved"`, by which the embedder states an
engine fact: the engine's bind mounts expose honest host file ownership to the
container (podman machine's virtiofs and native Linux binds present the
embedder user's real uid and modes; Docker Desktop's file-sharing layer masks
the mismatch, which is why default modes suffice there and the field stays
unset). When set, the client SHALL `chmod` the pre-created step write tree —
the step directory and each of its `STEP_SUBDIRS` — world-writable after
creating it, so the uid-1000 sandbox workload can write through such mounts.
The field names the fact, not the remediation: how the client compensates is
harness-owned and MAY change without changing the config surface. The mode
SHALL be applied with an explicit `chmod`, not `mkdir`'s mode option (which
the process umask masks), and SHALL be applied on replay when the directories
already exist. When unset, pre-creation SHALL keep today's default modes. The
loosening is scoped to the step write tree only: read-only mounts (analysis
tree, lib/ref stores) rely on standard world-read and SHALL NOT be relabeled
or re-moded.

#### Scenario: World-writable step tree under a podman connection

- **GIVEN** `engineBindOwnership: "host-preserved"`
- **WHEN** `createSandbox` pre-creates the step tree
- **THEN** the step directory and its subdirectories are world-writable
- **AND** a workload write from uid 1000 through the read-write bind succeeds

#### Scenario: Replayed pre-creation still applies the mode

- **GIVEN** `engineBindOwnership: "host-preserved"` and a step tree left by a prior attempt with default modes
- **WHEN** `createSandbox` runs again for the same step
- **THEN** the existing directories are re-moded world-writable rather than skipped

#### Scenario: Default modes when unset

- **GIVEN** no `engineBindOwnership`
- **WHEN** `createSandbox` pre-creates the step tree
- **THEN** directory modes are the process default, unchanged from today

### Requirement: Dynamic port mapping for host connectivity

The Docker backend SHALL use dynamic port mapping for `8765/tcp` bound to the
loopback host address (`HostIp: "127.0.0.1"`, `HostPort: ""` so Docker assigns a
free port), so the sandbox exec port is reachable from the host but not published on
any other host interface. The mapped port SHALL be retrieved after container start
via the Docker API. All HTTP communication with sandbox-server (health, submit, and
poll) SHALL use `127.0.0.1:{mappedPort}`.

#### Scenario: Exec port is published to loopback only

- **WHEN** the container is created
- **THEN** `8765/tcp` SHALL be bound with `HostIp: "127.0.0.1"` and a dynamically assigned host port
- **AND** the port SHALL NOT be published on `0.0.0.0`

#### Scenario: Parallel sandboxes get unique ports

- **WHEN** two sandboxes start concurrently
- **THEN** each gets a different host port
- **AND** both can be submitted to and polled independently

### Requirement: CPU and memory limits via the Docker API; no GPU passthrough

The Docker backend SHALL apply CPU and memory constraints via the Docker
container `HostConfig`: `NanoCpus` set to `round(cpu * 1e9)` and `Memory` set to
`memoryGb * 1024^3`. The Docker backend SHALL NOT request GPUs (no
`DeviceRequests`) — GPU scheduling is realized only by the K8s backend.

#### Scenario: CPU and memory limits applied

- **GIVEN** resources `{ cpu: 4, memoryGb: 16 }`
- **WHEN** the container is created
- **THEN** `NanoCpus` is `4_000_000_000` and `Memory` is `17_179_869_184`

#### Scenario: GPU request does not add a DeviceRequest

- **GIVEN** resources carrying a `gpu` field
- **WHEN** the Docker container is created
- **THEN** the `HostConfig` has no `DeviceRequests` entry

### Requirement: The cpu quota is visible inside the container

A cgroup quota is invisible to the runtimes inside it. `parallel::detectCores()`
greps `/proc/cpuinfo`, and `os.cpu_count()` reads
`/sys/devices/system/cpu/online`, and the two files describe the host. Thus the
Docker backend SHALL bind-mount two host-written files, read-only, over the two
paths. The files describe `floor(cpu)` cores (minimum 1): an `online` file with
`0-{n-1}`, and a `cpuinfo` file with the first `n` processor blocks of the
host's `/proc/cpuinfo`, when that file is readable. The backend SHALL also set
`MemorySwap` equal to `Memory`, thus a memory storm ends in an OOM kill and not
in a swap thrash.

The backend SHALL inject the shared thread-limit env (`thread-env.ts`). Each
thread-pool variable (`OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`,
`MKL_NUM_THREADS`, `R_DATATABLE_NUM_THREADS`, `NUMBA_NUM_THREADS`,
`NUMEXPR_MAX_THREADS`, `POLARS_MAX_THREADS`, `RAYON_NUM_THREADS`) SHALL be `1`.
Each worker-count variable (`BIOCPARALLEL_WORKER_NUMBER`, `LOKY_MAX_CPU_COUNT`)
SHALL be `floor(cpu)` (minimum 1). A fork copies the thread-pool size of its
parent, thus a pool at the quota runs `workers * quota` threads. One thread for
each pool is the safe default, and the agent raises it per command through the
exec `env`. `MC_CORES` SHALL NOT be set. `plan.env` and `extraEnv` SHALL
override these defaults.

#### Scenario: Core-count calls report the quota

- **GIVEN** resources `{ cpu: 2 }` on a 12-core host
- **WHEN** the container runs `parallel::detectCores()` or `os.cpu_count()`
- **THEN** both report `2`

#### Scenario: Thread pools default to one thread

- **GIVEN** resources `{ cpu: 2 }`
- **WHEN** the container is created
- **THEN** the env has `OMP_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1`, `BIOCPARALLEL_WORKER_NUMBER=2`, and no `MC_CORES`

#### Scenario: No swap

- **GIVEN** resources `{ memoryGb: 1 }`
- **WHEN** the container is created
- **THEN** `MemorySwap` equals `Memory`

### Requirement: Sandbox containers labeled for managed-sweep cleanup

Sandbox containers created by the Docker backend SHALL carry the labels
`app.kubernetes.io/managed-by=cortex`, `role=sandbox`,
`cortex/sandbox-id={sandboxId}`, `cortex/owner-workflow-id={childWorkflowId}`,
`cortex/run-id={runId}`, and `cortex/step-id={stepId}`. `listManagedSandboxes`
SHALL enumerate containers filtered by `app.kubernetes.io/managed-by=cortex`,
returning each one's `sandboxId`, `ownerWorkflowId`, and creation time, so the
scheduled reaper (`registerSandboxReaper`) can map a machine back to its owning
workflow and tear down orphans.

`ownerWorkflowId` is a DBOS lookup key, so every backend SHALL record and return
it verbatim, and SHALL report `null` rather than a rewritten value when it holds
no verbatim id: a lookup that fails against a lossy id proves nothing about the
owning workflow, so a lossy id is worse than none. Docker label values are
unconstrained, so this backend stores the id as given. A backend whose chosen
metadata namespace cannot hold the id unaltered — see the K8s label cap in the
harness-sandbox-exec spec — SHALL record it in one that can.

#### Scenario: Managed containers are enumerable for the reaper

- **GIVEN** two running sandbox containers labeled `app.kubernetes.io/managed-by=cortex`
- **WHEN** `listManagedSandboxes()` is called
- **THEN** it returns both, each carrying its `sandboxId` and `ownerWorkflowId` label values

#### Scenario: An owner id no label namespace could hold still round-trips

- **GIVEN** a sandbox created with a `childWorkflowId` that exceeds the K8s label
  value cap and carries characters illegal in one
- **WHEN** `listManagedSandboxes()` is called
- **THEN** the reported `ownerWorkflowId` SHALL equal the `childWorkflowId` byte for byte

#### Scenario: A machine recording no owner reports none

- **GIVEN** a managed machine carrying no owner workflow id
- **WHEN** `listManagedSandboxes()` is called
- **THEN** the reported `ownerWorkflowId` SHALL be `null`

#### Scenario: Reaper tears down an orphaned machine

- **GIVEN** a managed sandbox whose `cortex/owner-workflow-id` workflow is terminal or missing
- **WHEN** the reaper sweep runs
- **THEN** it calls `teardownById(sandboxId)` and reconciles the step row to a terminal status

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

### Requirement: K8s PVC subPaths derive from the resolved workspace root

The K8s backend addresses the session volume by `subPath`, so it SHALL be able to express a resolved workspace root as a path relative to the volume's root. `K8sClientConfig` SHALL therefore carry the `resolveWorkspaceRoot` seam and `sessionPvcRoot` — the absolute mountpoint of `sessionPvc` on the harness process's own filesystem. Whenever `sessionPvc` is configured, `sessionPvcRoot` SHALL be configured too.

The pod's read-only tree mount SHALL use `subPath = relative(sessionPvcRoot, resolveWorkspaceRoot(analysisId))`, and its read-write step mount SHALL use that path joined with `runs/{runId}/{stepId}`. Because `createSandbox` pre-creates the step tree under `resolveWorkspaceRoot(analysisId)` on the same volume, the directory the harness writes and the directory the pod mounts are then the same one by construction rather than by convention. The backend SHALL NOT derive the `subPath` from `analysisId` alone: that silently mounts a different directory for any embedder whose roots are not laid out as `{pvcRoot}/{analysisId}`.

A resolved root that does not live under `sessionPvcRoot` cannot be addressed as a `subPath` at all. The backend SHALL fail loudly in that case — `createSandbox` runs inside a DBOS workflow body, where a throw is the durable failure signal — rather than mounting a same-named sibling.

#### Scenario: subPath tracks a root that is not `{pvcRoot}/{analysisId}`

- **GIVEN** `sessionPvcRoot` `/sessions` and a resolver mapping `an-1` to `/sessions/tenants/acme/an-1`
- **WHEN** a sandbox is created for `an-1`, run `run-1`, step `step-a`
- **THEN** the read-only session mount has `mountPath: "/an-1"` and `subPath: "tenants/acme/an-1"`
- **AND** the read-write session mount has `mountPath: "/an-1/runs/run-1/step-a"` and `subPath: "tenants/acme/an-1/runs/run-1/step-a"`
- **AND** the container's paths are unchanged — the container never learns where the tree lives

#### Scenario: A root outside the PVC root is rejected

- **GIVEN** `sessionPvcRoot` `/sessions` and a resolver mapping `an-1` to `/elsewhere/an-1`
- **WHEN** a sandbox is created for `an-1`
- **THEN** creation throws, naming the root and the PVC root — no Job is created

#### Scenario: `sessionPvc` without `sessionPvcRoot` is a configuration error

- **GIVEN** `sessionPvc` is set and `sessionPvcRoot` is not
- **WHEN** a sandbox is created
- **THEN** creation throws, because the `subPath` of a workspace root cannot be derived

