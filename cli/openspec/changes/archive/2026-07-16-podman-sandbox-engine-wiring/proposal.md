## Why

The harness gains a configurable sandbox engine connection (`engineSocketPath`) and a step-tree access mode (`stepTreeAccess`) in its `podman-compatible-engine-connection` change — but the CLI's composition root still hard-codes the docker backend with no connection (`runtime.ts`, the `TODO(extend)` beside `env: { backend: "docker", namespace: "" }`). On a podman-pinned machine every sandbox step fails at container create even though the proxy, Postgres, and `ensureSandboxImage`'s pre-pull all run on podman — and when both engines are installed, the image lands in podman's store while containers are created against Docker (split-brain: pull and create target different engines). Wiring the pinned runtime through to the harness seam makes pull and create target the same engine by construction.

## What Changes

- The runtime descriptor surface (`lib/container.ts`) gains sandbox-engine socket resolution: Docker resolves to "no socket" (dockerode's default resolution, preserving `DOCKER_HOST`); Podman resolves the Docker-compat socket per platform — `podman machine inspect '{{.ConnectionInfo.PodmanSocket.Path}}'` on macOS, `podman info --format '{{.Host.RemoteSocket.Path}}'` (gated on the socket actually existing) on Linux. Resolution runs at every boot and is never persisted: the macOS socket lives under `$TMPDIR` and moves across machine restarts.
- The harness boot (`modules/harness/runtime.ts`) resolves the pinned runtime before building the sandbox client and passes `engineSocketPath` — plus `stepTreeAccess: "world-writable"` when the pinned runtime is podman (podman machine's virtiofs preserves host ownership honestly; Docker Desktop needs no loosening). The `TODO(extend)` hard-coding is retired.
- A failed resolution becomes a new `HarnessBootError` variant with an actionable message (start the podman machine on macOS; enable `podman.socket` / start `podman system service` on Linux) instead of a dockerode `ECONNREFUSED` mid-run.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `container-runtime`: new requirement — per-runtime sandbox-engine socket resolution on the descriptor surface (the same home as the existing per-runtime mount-arg divergence).
- `harness-runtime`: new requirement — the sandbox client's engine connection and step-tree access follow the pinned container runtime, resolved at boot with an actionable failure.

## Impact

- `cli/src/lib/container.ts` — socket resolution beside the runtime descriptors (config-free layer; the config-reading composition stays in the harness module).
- `cli/src/modules/harness/runtime.ts` — composition-root wiring, new boot-error variant.
- `cli/src/modules/harness/profile.ts` — boot-error → user-message mapping for the new variant.
- Tests: `lib/container.test.ts` (resolution per runtime/platform, injectable probe), harness boot tests (wiring + gate).
- Depends on `@inflexa-ai/harness` carrying the `podman-compatible-engine-connection` fields (dev flow: rebuild harness `dist` and reinstall in `cli/` before typecheck sees the new config fields).
