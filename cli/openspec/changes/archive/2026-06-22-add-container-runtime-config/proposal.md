## Why

The proxy lifecycle hard-codes `docker` as the container runtime in `proxy/setup.ts` — the literal appears in the two spawn wrappers and the readiness check. Users who run Podman instead of Docker (rootless setups, Podman-only Linux distros, license-averse shops) cannot start the proxy at all. Podman is a near-drop-in for the docker CLI, so a small, explicit runtime selector unblocks them — and gives us a clean seam for any future runtime or per-runtime command divergence (the Podman `:Z` mount relabel already needs one today).

## What Changes

- Add a `runtime` config key (`"docker" | "podman"`, default `"docker"`) alongside `telemetry` and `theme`.
- Introduce a container-runtime registry + execution wrapper in `lib/container.ts`: a `ContainerRuntime` descriptor per runtime (binary name, label, install/readiness hints, mount-arg builder) plus a shared spawn core (`capture`/`inherit`) and a generic `ensureReady` probe. Mirrors the existing `themes` registry shape.
- Rewrite `proxy/setup.ts` to drive every container call through the wrapper instead of the hard-coded `docker*` helpers — the binary, readiness error text, and bind-mount flags now come from the active runtime. Podman bind mounts gain the `:z` shared SELinux relabel suffix (shared, not private `:Z`, because the proxy and one-shot login containers mount the same dirs); Docker keeps the bare `host:ctr` form.
- Surface `runtime` in the settings TUI (`config.tsx`) as a radio group, following the existing `theme` selector pattern.
- Update Docker-specific wording in `env.ts` comments and the `inf setup` help text to be runtime-agnostic.

## Capabilities

### New Capabilities
- `container-runtime`: Selecting and driving the container backing system (Docker or Podman) for the proxy lifecycle — the config key, the runtime registry/descriptor, the execution wrapper, runtime-aware readiness checks, and per-runtime command divergence.

### Modified Capabilities
<!-- No existing spec covers the proxy/container lifecycle, so there are no requirement-level changes to an existing capability. -->

## Impact

- **Code**: `lib/container.ts` (new), `lib/config.ts` (schema + default), `src/modules/proxy/setup.ts` (rewrite container plumbing), `src/tui/config.tsx` (radio group), `src/lib/env.ts` (comment wording), `src/cli/index.ts` (help text).
- **Config**: new `runtime` key in `~/.config/inf/config.json`; defaults to `"docker"`, so existing installs are unaffected.
- **Dependencies**: none added — Podman is a runtime the user supplies; we only shell out to whichever binary is configured.
- **Behavior gaps (Podman, deferred)**: `--restart unless-stopped` does not survive a host reboot without systemd integration; tracked as `TODO(robustness)`, not solved here.
