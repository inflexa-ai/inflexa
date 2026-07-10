# Tasks — harden-workspace-root-seam

## 1. K8s subPath derives from the seam

- [x] 1.1 `sandbox/mount-plan.ts`: drop `sessionSubPathRO`/`sessionSubPathRW` from `MountPlan`; add `buildSessionSubPaths(coords, workspaceSubPath)` returning `{ ro, rw? }`, rejecting an empty, absolute, or `..`-bearing `workspaceSubPath`
- [x] 1.2 `sandbox/k8s-client.ts`: add `resolveWorkspaceRoot` + `sessionPvcRoot` to `K8sClientConfig`; derive the subPath via `relative(sessionPvcRoot, resolveWorkspaceRoot(analysisId))`; throw when `sessionPvcRoot` is missing or the root escapes it
- [x] 1.3 `sandbox/create-sandbox.ts`: thread `sessionPvcRoot` + `resolveWorkspaceRoot` into `createK8sSandboxOps`
- [x] 1.4 Tests: subPath tracks a non-conventional root; an escaping root throws; existing conventional-layout assertions still hold

## 2. The read seam owns its boundary

- [x] 2.1 `workspace/filesystem.ts`: wrap `resolveWorkspaceRoot` in `resolveFor`, returning `err(FsError)` with `op: "workspace.resolveWorkspaceRoot"`; `readFile`/`list`/`stat` propagate it
- [x] 2.2 Tests: a throwing resolver yields an err on all three methods; an out-of-scope path is still `ok({ kind: "out_of_scope" })`

## 3. Delete the dead mount model

- [x] 3.1 Delete `workspace/mount-strategy.ts` (no importers)
- [x] 3.2 `openspec/specs/workspace-profiles`: remove the `Docker mount builder in mount-strategy` requirement
- [ ] 3.3 Ask the deployment owner whether anything downstream consumed `buildPodMounts`/`buildDockerMounts`, and whether a managed content-server relied on `previews/{analysisId}/{previewId}` being a real filesystem path

## 4. Path-formula ownership

- [x] 4.1 `workspace/paths.ts`: add `PREVIEWS_ROOT`; `previewDir` composes it
- [x] 4.2 `memory/card-builders.ts`: join `PREVIEWS_ROOT` instead of the `"previews"` literal
- [x] 4.3 `index.ts`: drop the unused `stepWritePrefix` export; `create-sandbox.ts` uses it internally so the step-dir formula has one owner

## 5. Documentation truth

- [x] 5.1 `contracts/content-url.ts`: the `res` claim is URL space; state the on-disk location and that a serving host owns the mapping
- [x] 5.2 `openspec/specs/iterative-report`: purpose prose matches its own requirement

## 6. Gates

- [x] 6.1 `eslint.config.js`: teach `must-use-result` about a directly-chained `._unsafeUnwrapErr()` (incl. through `await`), rather than per-site disables
- [x] 6.2 Remove the unused `statusCodeOf` in `sandbox/docker-client.ts` — dead on `main` too, and it fails `bun run lint`
- [x] 6.3 `bun run typecheck`, `bun run lint`, `bun test` all green
