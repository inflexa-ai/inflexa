## Context

`createDockerSandboxOps` is the only place the harness touches a container engine: it constructs one `dockerode` client (`docker-client.ts:203`, `config.docker ?? new Docker()`) and every op — create/adopt, teardown, liveness, the reaper's listing — flows through it. The construction takes no options, so the backend can only reach dockerode's defaults (`DOCKER_HOST` env if the embedder happens to set it, else `/var/run/docker.sock`). The `docker?:` config slot is a test-only instance injection, not reachable from `CreateSandboxClientConfig`.

Podman serves the same REST API on a different socket. Live probing (podman 5.8.3, rootful podman-machine, macOS arm64) verified the backend's exact `createOpts` shape end-to-end — security config, loopback `HostPort: "0"` publish, label filters, `Created` unix-seconds, `State.Running`/`OOMKilled`, and the full poll-mode confinement chain (iptables/ip6tables install under `CAP_NET_ADMIN`, setpriv drop to uid 1000 with empty capability sets, host polls answered through `OUTPUT DROP`, egress and DNS blocked, rules un-flushable). Two divergences surfaced:

1. **Name conflict status**: a duplicate-name create answers HTTP 500 (`"cause": "that name is already in use"`), not Docker's 409. `createOrAdopt` reconciles only on exactly 409, so on podman a DBOS recovery re-run fails with `container_create_failed` instead of adopting its standing container.
2. **Honest bind ownership**: podman machine's virtiofs presents host dirs with the host owner's real uid and POSIX modes. The pre-created step tree (owned by the embedder process's uid, mode 755) rejects every write from the uid-1000 workload. Docker Desktop's file-sharing layer masks the same mismatch, which is why the mismatch is invisible today.

## Goals / Non-Goals

**Goals:**

- Make the engine connection an explicit, optional part of the backend's configuration surface, defaulting to today's behavior.
- Make recovery adoption independent of engine-specific status codes.
- Give embedders a supported way to keep the step tree writable under engines with honest bind ownership.

**Non-Goals:**

- A third `backend` id — podman is a connection to the docker-API backend, and `SandboxRef.backend: "docker"` keeps meaning "the Docker API".
- Image pull logic — pre-pull stays embedder-owned; once the embedder pulls and connects against the same engine, the docker-store/podman-store split-brain dissolves by construction.
- SELinux bind relabeling (`:z`) for podman on SELinux-enforcing Linux hosts, and validation of rootless podman networking (pasta/slirp4netns) — embedders gate those paths until validated.
- TCP/TLS engine connections — managed deployments run the k8s backend.

## Decisions

### `engineSocketPath?: string`, not a `Docker.DockerOptions` slice

The need on both engines is one value: which unix socket to dial. Exposing dockerode's full options type would couple the harness's public config surface to a third-party ~15-field type to satisfy a one-field need. A richer connection option later is a non-breaking optional-field addition. Unset preserves dockerode's default resolution, so `DOCKER_HOST` keeps working as the zero-config escape hatch it already is.

### Reconcile-by-inspect on any create failure, not status-code or message matching

Alternatives rejected: matching podman's 500 + message substring (couples the harness to one engine's error prose, breaks on the next engine or a fixed podman), and inspect-before-create (reintroduces a create/create race the current create-first shape avoids). Instead the conflict *signal* is dropped entirely: any create failure triggers an inspect of the checkpointed name. A standing container enters the unchanged owner-guard flow (adopt running owned, remove-and-recreate stopped owned, refuse foreign). No standing container means the failure wasn't a name conflict, and the **original create error** is returned — the inspect error is never surfaced, so a transient engine outage (both calls fail) still reports the create failure. Cost: one extra API call, only on the failure path. On Docker the 409 case lands in the identical reconcile flow as before.

### `stepTreeAccess?: "world-writable"` — a named policy, not a boolean or a raw mode

A bare `worldWritable: true` doesn't tell a composition-root reader why it exists; a raw `mode: number` invites cargo-culting arbitrary modes. A single-valued union reads as policy at the call site, carries the rationale in its JSDoc, and extends to future strategies (e.g. a chown-based one) without a breaking change. Absence keeps today's default modes.

Remedies rejected for the underlying uid mismatch: `chown` to uid 1000 host-side needs root on macOS; letting the poll-mode root entrypoint chown would widen the deliberately minimal `CapAdd` set with `CAP_CHOWN`/`CAP_FOWNER` (and callback mode has no root phase at all); podman's `keep-id` userns mapping is rootless-only. World-write on the step tree was verified live: the uid-1000 write lands, and the artifact round-trips to the host owned by the embedder's user, readable and deletable.

Scope: only the step write tree (`runs/{runId}/{stepId}` + `STEP_SUBDIRS`) — directories that exist to receive the sandbox's writes. Read-only mounts (analysis tree, ref store) need no loosening; world-read via standard 755/644 already suffices. Implementation note: `mkdir`'s `mode` option is masked by the process umask, so the mode is applied with explicit `chmod` after creation — also correct on replay, when the dirs already exist.

### No `engine: "docker" | "podman"` discriminator — capability knobs, not a product enum

The legible-looking alternative — one config field naming the engine, switched internally for both the socket and the step-tree mode — was rejected. It cannot replace `engineSocketPath` (the socket's location is host-lifecycle state only the embedder can resolve; the harness never shells out to `podman machine inspect`), so it would be an *additional* field, not a simpler one. For the step tree it is the wrong predicate: the write failure follows from bind mounts preserving a host uid that differs from the workload's uid 1000, which is true on podman machine's virtiofs but false on rootful podman-on-Linux when the host user is uid 1000 — and true again on Docker CE when the host user is *not* 1000, a legitimate Docker use of `stepTreeAccess` an engine switch would make unexpressible. The reconcile fix is deliberately unswitched (better on both engines); an engine enum invites per-engine conflict-status tables that rot as engines change. Other docker-API engines (Colima, OrbStack, Rancher Desktop) each carry their own mount semantics — an enum grows a per-product behavior table inside the host-agnostic harness, while capability knobs stay truthful. The readable "because podman" mapping lives at the embedder's composition root, the one place that knows the product name; an embedder worried about mis-combining the knobs wraps them in its own resolver that returns the pair together.

### The mode knob lives on `CreateSandboxClientConfig`, applied in `precreateStepTree`

`precreateStepTree` is already the one backend-agnostic choke point that creates the tree. The knob is docker-backend-motivated but harmless if a future backend needs it; the k8s path simply never sets it.

## Risks / Trade-offs

- [World-writable step dirs on a shared host let any local user write into a step's artifact tree] → opt-in, embedder-chosen, scoped to the step tree only; the target machines are single-user dev boxes, and provenance signing happens over content the harness reads back.
- [Reconcile-by-inspect could adopt a container when create failed for an unrelated reason while an owned container stands] → that is precisely the recovery scenario the adoption exists for; the owner-guard already refuses foreign containers, and an adopted container is still health-verified before use.
- [Rootless podman on Linux (pasta/slirp4netns loopback publish, iptables in a user namespace) is unvalidated] → out of scope here; the connection seam makes it *reachable*, and embedders gate it with an actionable launch error until validated.
- [`engineSocketPath` pointing at a dead socket surfaces as a dockerode connect error mid-step] → embedder responsibility to resolve and gate at boot (the cli change); the harness error already carries the cause chain.

## Migration Plan

Both new fields are optional with absent-means-today semantics; no existing embedder, test, or managed deployment changes behavior. Rollback is unsetting the fields. No data or schema migration.

## Open Questions

_None blocking._ Follow-ups tracked outside this change: rootless-Linux validation matrix, SELinux `:z` knob for the mount plan, and the cli composition-root wiring (its own change in `cli/openspec`).
