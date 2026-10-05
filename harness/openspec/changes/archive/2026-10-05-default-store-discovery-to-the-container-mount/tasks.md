## 1. One source for the container paths

- [x] 1.1 Export `LIBS_CONTAINER_PATH` and `REFS_CONTAINER_PATH` from `src/sandbox/mount-plan.ts`, documenting that they are also the discovery tools' default read root.
- [x] 1.2 Import `REFS_CONTAINER_PATH` in `src/tools/sandbox/list-available-refs.ts` as the `REFS_ROOT` it re-declared, keeping the name so every render site is untouched.
- [x] 1.3 Derive `DEFAULT_PACKAGES_FILE` in `src/tools/sandbox/list-available-packages.ts` from `LIBS_CONTAINER_PATH`; the value is unchanged, so the lib-store behaviour and its spec are untouched.

## 2. The fallback

- [x] 2.1 Resolve the read root once in `createListAvailableRefsTool` as `deps.refStorePath ?? REFS_ROOT`, so the default is named where the dep is consumed rather than at the scan site.
- [x] 2.2 Narrow `scanStore` to `root: string` and drop the `!root` branch, which no caller can now reach.
- [x] 2.3 Test that an omitted path and an explicit `/mnt/refs` produce identical results. Asserting the equivalence rather than a fixed state keeps the test from depending on whether the machine running it happens to have that mount.
- [x] 2.4 Move the "No reference store is provisioned" content assertion onto the configured-but-missing case, which still exercises that render path.

## 3. The contract

- [x] 3.1 Rewrite the `EnvironmentStorePaths` absence paragraph so both fields mean the same thing by an omitted path, and state the stat-before-report invariant that makes the fallback safe.
- [x] 3.2 Restate `refStorePath`'s field doc in terms of where the HOST reads the store, naming both cases: a K8s pod holding the PVC (omit) and a native process bind-mounting a directory into Docker (set).
- [x] 3.3 Correct the ref-store discovery requirement — the tool reads the host filesystem and declares no execution mode; the sandbox-exec sentence described a shape the code has not had since the tool became a planner tool.

## 4. Verification

- [x] 4.1 `bun run typecheck` and `bun run lint` clean.
- [x] 4.2 `bun test src/tools/sandbox src/sandbox/mount-plan.test.ts` green.
- [x] 4.3 Patch bump to 0.19.1 — an additive fallback, no signature an embedder passes. Kept as its own release commit; merging it publishes to npm.
- [ ] 4.4 After publish: bump Cortex's pin and confirm `list_available_refs` reports the staging store with no `REF_STORE_PATH` set.
