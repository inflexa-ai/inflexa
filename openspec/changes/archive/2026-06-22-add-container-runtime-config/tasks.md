## 1. Runtime registry + wrapper (`lib/container.ts`)

- [x] 1.1 Define `ContainerRuntimeId` (`"docker" | "podman"`), `runtimeIds` (the id list, mirroring `themeIds`, ordered `["docker", "podman"]` so Docker is the first option), and the `ContainerRuntime` descriptor type (`id`, `bin`, `label`, `notFoundHint`, `notReadyHint`, `mountArg`). JSDoc every exported declaration.
- [x] 1.2 Build the `runtimes` registry: a `docker` descriptor (`mountArg` → `host:ctr`) and a `podman` descriptor (`mountArg` → `host:ctr:z`, shared relabel), each with runtime-specific install + readiness hint strings.
- [x] 1.3 Implement `activeRuntime()` — read `readConfig().runtime` and return the matching descriptor.
- [x] 1.4 Implement the shared spawn core: `capture(rt, args)` (returns `{ code, stdout, stderr }`) and `inherit(rt, args)` (returns exit code), both spawning `[rt.bin, ...args]`.
- [x] 1.5 Implement `ensureReady(rt)` — `Bun.which(rt.bin)` then an `info` probe; throw a `ContainerRuntimeError` (a new error type owned by `lib/container.ts`) carrying `rt.notFoundHint` (missing) or `rt.notReadyHint` (not ready). Do NOT reuse `ProxyError` — `lib/` must never import the proxy module (it would invert the dependency and create a cycle).

## 2. Config key (`lib/config.ts`)

- [x] 2.1 Add `runtime: z.enum(runtimeIds).catch("docker").default("docker")` to `configSchema`, importing `runtimeIds` from `lib/container.ts`.
- [x] 2.2 Include `runtime: "docker"` in the `readConfig` fail-closed fallback object so the shape stays complete.

## 3. Rewrite proxy plumbing (`src/modules/proxy/setup.ts`)

- [x] 3.1 Resolve `activeRuntime()` once at the entry of `setup()` and `ensureProxyReady()`; thread the descriptor into the container calls.
- [x] 3.2 Replace `dockerCapture`/`dockerInherit` call sites with `capture(rt, …)`/`inherit(rt, …)` and remove the now-dead private `docker*` helpers + `DockerResult` type.
- [x] 3.3 Replace `ensureDocker()` with `ensureReady(rt)`; remove the docker-specific readiness strings now owned by the descriptor. Adapt the thrown `ContainerRuntimeError` so the proxy's catch blocks still print its actionable `.message` — broaden the `instanceof ProxyError` checks in `setup()`/`ensureProxyReadyOrExit()` to also match `ContainerRuntimeError` (imported from `lib/container.ts`).
- [x] 3.4 Build bind mounts via `rt.mountArg(host, ctr)` in `volumeArgs()` so Podman gets `:z` and Docker does not.
- [x] 3.5 Add a `TODO(robustness)` on the `--restart unless-stopped` arg noting Podman won't persist it across a host reboot without systemd.
- [x] 3.6 Update the module header comment and any "Docker" wording to be runtime-agnostic.

## 4. Settings UI (`src/tui/config.tsx`)

- [x] 4.1 Add a `runtime` radio group following the existing `theme` section: one row per `runtimeId`, active marker, included in the navigable `rows` list and the `dirty()` check.
- [x] 4.2 Wire selection into `draft`/`save` so choosing a runtime writes `runtime` to config; show the active runtime marked on load.

## 5. Wording cleanup

- [x] 5.1 Update `src/lib/env.ts` comments that say "Docker"/"Docker container" to runtime-agnostic wording (no functional change to paths or port).
- [x] 5.2 Update the `inf setup` command description in `src/cli/index.ts` ("(Docker)") to be runtime-agnostic.

## 6. Verify

- [x] 6.1 `bun run typecheck` and `bun run lint` pass.
- [x] 6.2 `bun run format:file` on every changed file under `src/`.
- [x] 6.3 Manual smoke: default config resolves to Docker and proxy starts unchanged; setting `runtime: podman` routes commands to the `podman` binary and applies `:z` mounts (verify the constructed argv even if Podman isn't installed locally).
