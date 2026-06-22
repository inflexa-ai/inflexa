## Context

The proxy lifecycle (`src/modules/proxy/setup.ts`) provisions CLIProxyAPI as a container. Every container call funnels through two private wrappers — `dockerCapture` (captures stdout/stderr/code) and `dockerInherit` (inherits stdio) — plus `ensureDocker` (a `Bun.which("docker")` + `docker info` readiness probe). The literal `"docker"` appears in exactly those three spots; everything else is plain subcommands (`info`, `image inspect`, `pull`, `ps`, `rm`, `run`, `start`) and flags that Podman accepts verbatim.

Config lives in `src/lib/config.ts` as a small zod schema (`telemetry`, `theme`). The `theme` key already demonstrates the exact pattern this change needs: an enum config key backed by a registry (`themeIds` + `themes` in `lib/themes.ts`), validated with `z.enum(themeIds).catch(...).default(...)`, and surfaced as a radio group in `src/tui/config.tsx`. The container runtime is structurally identical to a theme.

Constraints (from CLAUDE.md): no new dependencies; domain types over raw strings for known value sets; `lib/` is for cross-cutting infra with no single owner; modules import infra, never `tui/`; column/field/param ordering is identity → core → FKs; `function`/`const`/`type` preferences; JSDoc on every exported declaration.

## Goals / Non-Goals

**Goals:**

- Let users select Docker or Podman via a persisted config key, defaulting to Docker.
- Route all container invocations through one execution wrapper that resolves the binary from config.
- Give each runtime a descriptor that owns its divergences (binary, labels, readiness hints, mount-arg builder), so a third runtime or a new quirk is an additive change, not a call-site edit.
- Make readiness errors name the active runtime and give runtime-specific remediation.

**Non-Goals:**

- Auto-detecting the installed runtime or auto-switching. Default is a hard `docker`; detection is at most a friendly hint in an error string.
- Validating runtime availability at config-save time. Settings writes stay pure (no shelling out); availability is checked at use.
- Solving Podman restart-persistence across reboots (no daemon → needs systemd/quadlets). Tracked as `TODO(robustness)`.
- A full semantic command builder. The wrapper passes raw arg arrays; only the genuinely divergent bits live on the descriptor.

## Decisions

### Decision: A `lib/container.ts` registry + wrapper, modeled on `themes`

The runtime selector is cross-cutting infrastructure with a real domain type and registry — the same category as `lib/themes.ts` — so it belongs in `lib/`, not buried in the proxy module. The "no single-caller helper" rule exempts this: we are extracting a registry + domain type, not a one-line function. `lib/config.ts` imports the runtime-id list for its `z.enum`, exactly as it imports `themeIds`.

Shape:

```ts
type ContainerRuntimeId = "docker" | "podman";

type ContainerRuntime = {
    id: ContainerRuntimeId;
    bin: string;            // "docker" | "podman" — the 95% case
    label: string;          // "Docker" | "Podman" — UI + error text
    notFoundHint: string;   // install guidance when bin is absent
    notReadyHint: string;   // docker: start daemon · podman: podman machine start
    mountArg(host: string, ctr: string): string;  // the real divergence (:z for podman — shared relabel)
};
```

Shared core (parameterized by the resolved runtime, not duplicated per runtime):

- `activeRuntime(): ContainerRuntime` — reads config, looks up the registry.
- `capture(rt, args)` / `inherit(rt, args)` — the two spawn variants, `Bun.spawn({ cmd: [rt.bin, ...args] })`.
- `ensureReady(rt)` — `Bun.which(rt.bin)` then an `info` probe; throws a `ContainerRuntimeError` (owned here) carrying `rt.notFoundHint` / `rt.notReadyHint`. `lib/` must not import the proxy module, so it cannot throw `ProxyError`.

**Why over alternatives:** A bare binary-name swap (just read config in the spawn wrappers) was rejected because the `:Z` mount divergence already exists and a bare swap forces a call-site `if`. A full semantic command builder (`rt.run({image, ports, mounts})`) was rejected as over-engineering for ~6 call sites — we start thin and graduate a single command to a semantic helper only if a *whole subcommand* ever diverges.

### Decision: `proxy/setup.ts` resolves the runtime once and threads it

`setup()` and `ensureProxyReady()` call `activeRuntime()` once at entry and pass the descriptor down to the container calls, rather than each helper re-reading config. The existing private `docker*` helpers are removed in favor of the wrapper; `ensureDocker` becomes `ensureReady(rt)`; `volumeArgs()` uses `rt.mountArg(...)`. The `ProxyError` type and proxy-specific orchestration stay in the module. The proxy adapts `ensureReady`'s `ContainerRuntimeError` (imported from `lib/container.ts`) so its catch blocks still print the actionable `.message`.

**Why:** resolve-once is the repo's stated preference (single source of truth over repeated reads) and keeps the descriptor explicit at each call site.

### Decision: Settings UI mirrors the `theme` radio section

`config.tsx` gets a second radio group for `runtime`, following the existing `theme` section (rows, active marker, persists on save). Because `runtime` is an enum — not a boolean — it cannot use the `BooleanSettingKey` toggle machinery; it follows the theme pattern instead. Whether to generalize "radio setting" into one reusable concept (theme + runtime) or copy the section is a local implementation call left to the tasks.

### Decision: Wording cleanup is part of the change

`env.ts` comments and the `inf setup` help text (`src/cli/index.ts`) say "Docker"/"Docker container". These become runtime-agnostic ("container") so the docs don't lie under Podman. The fixed in-container Linux paths and the proxy port are unchanged.

## Risks / Trade-offs

- **Podman `--restart unless-stopped` won't survive a host reboot** (no daemon) → ship as-is with a `TODO(robustness)`; the proxy still auto-starts within a session via `ensureContainerRunning`. Out of scope to solve now.
- **`:z` (shared) relabel applied for Podman** could be surprising on a non-SELinux host → `:z` is harmless without SELinux. Shared (`:z`), not private (`:Z`), because the long-running proxy and the one-shot login container mount the same host dirs — a private relabel would let a re-login break the running proxy's access.
- **Readiness probe (`info`) semantics differ** (Docker daemon vs Podman machine) → mitigated by per-runtime `notReadyHint`; the probe command (`info`) is the same and is a valid usability check for both.
- **User selects an uninstalled runtime** → no save-time validation, so the failure surfaces at next `inf` launch — mitigated by `ensureReady` throwing a clear, runtime-named `ProxyError` before the renderer takes over.

## Open Questions

- Should the missing-Docker error string include a "Podman detected — set runtime in `inf config`" nudge when the other runtime is present? Cheap and kind; defer to implementation taste.
- Generalize the `config.tsx` radio-row concept (theme + runtime) or copy it? Resolve while implementing the settings task.
