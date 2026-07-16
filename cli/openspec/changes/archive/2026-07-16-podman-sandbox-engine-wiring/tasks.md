# Tasks

## 1. Socket resolution on the descriptor surface

- [x] 1.1 Add sandbox-engine socket resolution to `src/lib/container.ts`: docker → no socket; podman → `podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` on darwin, `podman info --format '{{.Host.RemoteSocket.Path}}'` + on-disk existence gate on linux; runtime-specific actionable errors (`podman machine start` / `systemctl --user enable --now podman.socket`); probe injectable like `ensureReady`; result on the `Result` channel, never persisted.
- [x] 1.2 Tests (`src/lib/container.test.ts`): per-runtime and per-platform resolution, missing-socket gate, stopped-machine failure text, injected probe exercises all branches without spawning binaries.

## 2. Boot wiring

- [x] 2.1 Ensure the local `@inflexa-ai/harness` carries the `podman-compatible-engine-connection` fields (`engineSocketPath`, `stepTreeAccess`): `bun run harness:local` (builds `../harness` and `bun link`s it — the cli consumes the published registry package otherwise, so a local dist rebuild alone is invisible to it).
- [x] 2.2 In `src/modules/harness/runtime.ts`, resolve the pinned runtime + engine socket among the boot pre-flight gates (before the sandbox client exists), replace the `TODO(extend)` hard-coding: pass `engineSocketPath`, and `stepTreeAccess: "world-writable"` only when the pin is podman; docker pin passes neither.
- [x] 2.3 Add the `HarnessBootError` variant for failed resolution and its actionable message in `bootErrorMessage` (`src/modules/harness/profile.ts`), naming the runtime-specific remediation.
- [x] 2.4 Tests: boot passes the resolved socket + step-tree access through to `createSandboxClient` under a podman pin (seam-injected resolver); docker pin produces today's exact config; failed resolution fails boot before side effects with the new variant.

## 3. Verification

- [x] 3.1 `bun run typecheck`, `bun run lint`, and `bun test` from `cli/` (never the monorepo root).
- [x] 3.2 `bun run format:file` on every touched file under `src/`.
- [x] 3.3 `openspec validate podman-sandbox-engine-wiring` passes; deltas archive cleanly against `container-runtime` and `harness-runtime`.
- [x] 3.4 Live smoke on this machine (podman pinned, fresh `inflexa sandbox pull` so the local `:latest` carries the poll-mode entrypoint): a data-profile or run step creates its sandbox on podman, writes artifacts through the step tree, and tears down.
