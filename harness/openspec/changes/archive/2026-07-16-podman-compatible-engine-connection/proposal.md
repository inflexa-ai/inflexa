## Why

The Docker sandbox backend hard-wires its engine connection: `createDockerSandboxOps` constructs `new Docker()` with default options (`docker-client.ts`), so sandboxes can only ever reach the default Docker socket. Podman ships a Docker-compatible REST API, and live probing (podman 5.8.3, rootful machine, macOS arm64) confirmed the backend's entire surface — create/start/inspect with the full security config, loopback port publish, label-filtered listing, the poll-mode egress firewall and setpriv drop — behaves identically through podman's compat socket. Only three gaps stand between the harness and running on podman exactly as on Docker, and none of them is a podman-specific backend: the unreachable connection target, one engine divergence in the name-conflict status code, and one host-ownership divergence on the read-write step mount. On a podman-pinned machine today, every sandbox step fails at container create even though the embedder's image pull, proxy, and Postgres all run fine on podman — or worse, with both engines installed, the image lands in podman's store while containers are created against Docker (split-brain).

## What Changes

- `CreateSandboxClientConfig` and `DockerClientConfig` gain `engineSocketPath?: string` — the unix socket of the Docker-API engine to dial (a Docker daemon or a podman compat socket), threaded to the single `new Docker()` construction site. Unset keeps dockerode's default resolution (`DOCKER_HOST`, then `/var/run/docker.sock`), so existing embedders and the managed deployment are untouched.
- `createOrAdopt`'s recovery reconciliation becomes engine-agnostic: on **any** `createContainer` failure it inspects the checkpointed name — a standing container enters the existing owner-guard flow (adopt running / recreate stopped / refuse foreign), no standing container returns the original create error. This replaces the 409-only trigger, which podman breaks by answering a duplicate-name create with HTTP 500 (`"that name is already in use"`) instead of Docker's 409.
- `CreateSandboxClientConfig` gains `stepTreeAccess?: "world-writable"` — when set, the pre-created step tree (step dir + subdirs) is `chmod`ed world-writable so the uid-1000 sandbox workload can write it through engines whose bind mounts preserve host ownership honestly (podman machine's virtiofs presents the host owner's uid; Docker Desktop's sharing layer masks the mismatch). Absent keeps today's default modes.
- `backend: "docker" | "k8s"` is unchanged: podman is a *connection* to the docker-API backend, not a third backend id.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `docker-sandbox-provider`: the factory's engine connection becomes configurable (`engineSocketPath`); the recovery-idempotency requirement's trigger changes from "HTTP 409" to "any create failure with a standing container under the checkpointed name"; a new requirement covers the `stepTreeAccess` mode on step-tree pre-creation.

## Impact

- `harness/src/sandbox/docker-client.ts` — `DockerClientConfig` field, `new Docker(...)` construction, `createOrAdopt` reconciliation trigger.
- `harness/src/sandbox/create-sandbox.ts` — `CreateSandboxClientConfig` fields threaded to `createDockerSandboxOps`; `precreateStepTree` applies the step-tree access mode.
- Tests: `docker-client.test.ts` (socket-path threading; reconcile on a 500-shaped conflict; reconcile skipped when no container stands), `create-sandbox.test.ts` (step-tree mode application).
- K8s backend, submit/await protocol, mount plan container paths, `SandboxRef`, reaper/watchdog: untouched (all engine access already flows through the one constructed `Docker` instance).
- Embedder follow-up (separate cli change): resolve the pinned runtime's socket at boot and pass `engineSocketPath` + `stepTreeAccess`.
