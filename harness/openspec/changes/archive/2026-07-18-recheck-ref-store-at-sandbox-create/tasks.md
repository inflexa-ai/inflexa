## 1. Harness: create-time ref-store check

- [x] 1.1 Add a ref-store existence check beside `libStoreUsable` in `src/sandbox/docker-client.ts`: `lstat`-based `isDirectory`, symlinks rejected, throw → false. Comment the two deliberate asymmetries vs libs: shallow existence-only (no layout validation — receipts are embedder-owned) and silent skip (missing refs = normal cold state, not a degradation; no warn).
- [x] 1.2 In `createSandbox`, compute `refsMounted` from that check at create time; feed `refs: refsMounted` into `buildMountPlan` and gate the `/mnt/refs` bind entry on `refsMounted` instead of raw `config.refStorePath`. Document on `DockerClientConfig.refStorePath` that embedders pass the configured location unconditionally and existence is checked per create.

## 2. Harness: tests (`src/sandbox/docker-client.test.ts`, mirroring the lib-recheck coverage)

- [x] 2.1 `refStorePath` set but directory missing at create → no `/mnt/refs` bind, no directory created at the path, no warning logged.
- [x] 2.2 Directory created after ops construction but before `createSandbox` → the bind is present (mid-session install becomes visible without reboot).
- [x] 2.3 `refStorePath` names a symlink resolving to a directory → no bind.
- [x] 2.4 Directory present throughout → read-only bind at `/mnt/refs` (existing behavior preserved).

## 3. Harness: verification

- [x] 3.1 Run the harness typecheck and test suite; all green.

## 4. Embedder wiring (cli repo — needs the harness change in `node_modules`, locally via `bun run harness:local`)

- [x] 4.1 In `cli/src/modules/harness/runtime.ts`, replace `...existingRefStoreConfig(env.refsDir)` with `refStorePath: env.refsDir`.
- [x] 4.2 Delete `existingRefStorePath`/`existingRefStoreConfig` and `cli/src/modules/harness/runtime_refs.test.ts` (no other consumers).
- [x] 4.3 Run cli typecheck + tests; format the changed `src/` files with `bun run format:file`.

## 5. End-to-end acceptance (issue #151 "Done when")

- [x] 5.1 With no refs dir, start a chat, run `inflexa refs download <id>` mid-session, trigger a step that creates a new sandbox, and confirm it sees `/mnt/refs` without restarting the chat. Verified end-to-end against the live podman engine with the real sandbox image: from one `createDockerSandboxOps` instance, sandbox #1 (refs dir absent) got no `/mnt/refs` and did not auto-create the dir; after `mkdir` + marker, sandbox #2 mounted `/mnt/refs` read-only and read the marker — no restart.
