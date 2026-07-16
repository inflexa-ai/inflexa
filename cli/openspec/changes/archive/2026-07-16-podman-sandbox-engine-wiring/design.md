## Context

The CLI treats Docker and Podman as interchangeable for everything it runs itself: `ensureRuntime` (lib/config.ts) pins one at first need, `ensureSandboxImage` (modules/harness/profile.ts) pre-pulls the sandbox image via the pin, and the compose stack runs on it. Sandboxes are the exception — `bootHarnessRuntimeOnce` (modules/harness/runtime.ts) constructs `createSandboxClient` with a hard-coded docker backend and no connection, so the harness's dockerode client dials the default Docker socket regardless of the pin. The harness-side seam (`engineSocketPath`, `stepTreeAccess` — see `harness/openspec/changes/podman-compatible-engine-connection`) makes the connection an embedder-supplied value; this change supplies it.

Verified on a live rootful podman machine (macOS arm64, podman 5.8.3): `podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` yields a working Docker-compat socket (under `$TMPDIR`), and the full sandbox `createOpts` shape behaves identically to Docker through it.

## Goals / Non-Goals

**Goals:**

- Sandbox containers are created against the engine the CLI pinned — the same engine that pulled the image.
- A podman configuration that cannot serve sandboxes fails at boot with a runtime-specific, actionable message.
- Docker-pinned machines observe zero behavior change.

**Non-Goals:**

- Changing the pin logic, the compose stack, or `ensureSandboxImage` — pull already follows the pin; once create does too, the split-brain dissolves with no further code.
- Validating rootless podman on Linux (pasta/slirp4netns) — the launch gate's honest error covers the unvalidated path.
- Persisting the resolved socket — it is machine-lifecycle state, not configuration.

## Decisions

### Socket resolution lives on the runtime descriptor surface (`lib/container.ts`)

The container-runtime spec already routes per-runtime divergence through the descriptor (the `:z` mount-arg precedent) rather than call-site conditionals. Resolution follows the same shape: a descriptor-level resolver the harness module calls with the pinned runtime. It stays config-free (the layer's existing constraint — `lib/config.ts` imports `runtimeIds` from it, so no cycle) and spawns the runtime binary through the existing `capture` wrapper, injectable for tests exactly like `ensureReady`'s probe.

### Per-platform podman resolution, gated on the socket actually existing

- **macOS**: `podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` — the host-forwarded compat socket. A stopped machine fails the inspect; the error hints `podman machine start`.
- **Linux**: `podman info --format '{{.Host.RemoteSocket.Path}}'` — with an existence check on the returned path, because `podman info` succeeding does **not** imply the API service is listening (the podman CLI talks to the engine directly; the REST socket exists only when `podman.socket` is enabled or `podman system service` runs). The error hints `systemctl --user enable --now podman.socket`.
- **Docker**: resolves to `undefined` — dockerode's default resolution keeps working, including the `DOCKER_HOST` escape hatch users may already rely on.

Resolved at every boot, never written to config: the macOS socket lives under `$TMPDIR` and moves across machine restarts, so a persisted path is a future ECONNREFUSED.

### Boot gates on resolution before the sandbox client exists

Resolution runs in `bootHarnessRuntimeOnce` alongside the other prerequisite gates (skills dir, embedder probe, Postgres), producing a dedicated `HarnessBootError` variant on failure. The alternative — let dockerode fail on first use — surfaces as an opaque `ECONNREFUSED` in the middle of a paid agent run; the boot gate converts it into a free, actionable failure. Docker-pinned boots skip the gate's engine-specific work entirely (nothing to resolve).

### `stepTreeAccess: "world-writable"` is passed only when the pin is podman

Docker Desktop's file-sharing layer masks the host-uid mismatch, so docker-pinned machines keep today's tighter step-tree modes; loosening them there would be a behavior change with no beneficiary. The knob's meaning and mechanism are harness-owned; the CLI only decides *when* it applies, which is exactly the embedder-supplies-values boundary rule.

## Risks / Trade-offs

- [`podman machine` output format drifts across podman versions] → the resolver is one descriptor function with an injectable probe; a format change breaks one test, not scattered call sites.
- [Rootless podman on Linux resolves a socket but sandbox networking is unvalidated] → accepted: the connection will reach the engine and any failure is observable; the harness change records the validation gap, and gating harder here would block valid rootful-Linux setups.
- [A user switches the pinned runtime between boots while sandbox rows reference containers on the other engine] → the watchdog's `isAlive` 404s against the new engine, which is the existing observably-dead path (synthetic step failure); no new handling.
- [Harness/CLI version skew: this wiring compiles only against a harness carrying the new fields] → the dev flow already rebuilds `file:../harness` (dist staleness is a known gotcha); tasks order the harness change first.

## Migration Plan

Additive wiring behind the existing pin; docker-pinned machines take the `undefined`-socket path, which is byte-identical to today. Rollback is reverting the wiring commit. No config or data migration.

## Open Questions

_None blocking._
