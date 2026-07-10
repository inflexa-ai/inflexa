# Harden the workspace-root seam

## Why

`add-workspace-root-resolver` replaced the process-global `sessionsBasePath` string with the `resolveWorkspaceRoot(resourceId)` seam, but three surfaces did not follow it through:

- **K8s stopped honouring the seam.** `createSandbox` pre-creates the writable step tree at `resolveWorkspaceRoot(analysisId)/runs/{runId}/{stepId}`, while `sandbox/mount-plan.ts` still hardcodes the pod's PVC `subPath` as `{analysisId}/runs/{runId}/{stepId}`. The two agree only when the embedder's roots happen to be laid out as `{pvcRoot}/{analysisId}`. Previously both derived from `sessionsBasePath`, so the agreement was structural; now it is an unenforced convention that nothing in the type system checks and no test covers.
- **The read seam promises `Result` but calls a function that throws.** `ResolveWorkspaceRoot` is specified to throw for an unresolvable resource — correct inside a DBOS body, where only a throw records a step as durably failed. `WorkspaceFilesystem.readFile`/`list`/`stat` are typed `ResultAsync<_, FsError>` and call it with no `try`. They are reachable from a live chat turn whose analysis folder may have been moved or deleted since the turn began; today the throw only fails to escape because `dispatchTool` happens to wrap `tool.execute` in a `catch` two layers away.
- **`workspace/mount-strategy.ts` has no importers.** `buildMountPaths`, `buildPodMounts`, and `buildDockerMounts` are unreferenced; `sandbox/mount-plan.ts` is the live model. `workspace-profiles` still specifies the dead module as the mount source of truth.

Two documentation surfaces also drifted: `contracts/content-url.ts` still asserts previews live at `/sessions/previews/{analysisId}/{previewId}` on disk, and `iterative-report` repeats that path — both contradict `workspace-layout`, which correctly puts them at `{workspaceRoot}/previews/{previewId}`. `contracts/content-url.ts` is the file a managed host or its Go mirror reads.

## What Changes

- **K8s `subPath` derives from the seam.** `K8sClientConfig` gains `resolveWorkspaceRoot` and `sessionPvcRoot` (the PVC's mountpoint on this process's filesystem). The pod's `subPath` becomes `relative(sessionPvcRoot, resolveWorkspaceRoot(analysisId))`, so the directory the harness pre-creates and the directory the pod mounts are the same one by construction. A root outside `sessionPvcRoot` — unaddressable as a `subPath` — throws rather than silently mounting a same-named sibling.
- **`buildMountPlan` sheds the PVC `subPath`s.** They were never container-path concerns; a new `buildSessionSubPaths(coords, workspaceSubPath)` owns them, and `MountPlan` keeps only what both backends share.
- **`WorkspaceFilesystem` converts the resolver's throw at its boundary.** An unresolvable root becomes `err(FsError)` with `op: "workspace.resolveWorkspaceRoot"` — a value, not an exception that survives on a distant caller's `catch`.
- **BREAKING — `workspace/mount-strategy.ts` is deleted**, and the `workspace-profiles` requirement naming it is removed. The mount model lives in `sandbox/mount-plan.ts`.
- **`stepWritePrefix` leaves the public barrel.** Nothing imports it; `create-sandbox.ts` now uses it internally so the step-dir formula has one owner rather than three spellings.
- `previews/` gains a `PREVIEWS_ROOT` constant so the segment is spelled once; `previewDir` composes it.
- Doc-only: `contracts/content-url.ts` and `iterative-report` stop describing the pre-`add-workspace-root-resolver` filesystem layout.

## Capabilities

### New Capabilities

_None — the change hardens capabilities `add-workspace-root-resolver` introduced._

### Modified Capabilities

- `workspace-root-resolution`: the seam's throw contract is scoped to DBOS bodies; a `Result`-returning consumer SHALL convert at its own boundary. Embedders MAY memoize resolutions provided the memo is process-local (a recovered workflow on a fresh process still derives from durable state).
- `docker-sandbox-provider`: the K8s backend derives PVC `subPath`s from `resolveWorkspaceRoot` relative to `sessionPvcRoot`, and rejects a root outside it.
- `harness-workspace-tools`: the read seam returns `err(FsError)` for an unresolvable workspace root.
- `workspace-profiles`: the `mount-strategy` mount-builder requirement is removed.

## Impact

- **Code**: `sandbox/mount-plan.ts` (drop `sessionSubPath*` from `MountPlan`, add `buildSessionSubPaths`), `sandbox/k8s-client.ts` (`resolveWorkspaceRoot` + `sessionPvcRoot`, derive `subPath`), `sandbox/create-sandbox.ts` (thread both; use `stepWritePrefix`), `workspace/filesystem.ts` (boundary conversion), `workspace/paths.ts` (`PREVIEWS_ROOT`), `memory/card-builders.ts`, `index.ts` (drop `stepWritePrefix`), `contracts/content-url.ts` (doc), **delete** `workspace/mount-strategy.ts`.
- **Doc-only, applied directly to the main specs** (purpose prose, no requirement changed): `iterative-report`'s summary said previews live at `previews/{analysisId}/{previewId}/v{N}` on disk while its own requirement already said `{workspaceRoot}/previews/{previewId}/v{N}`.
- **Lint**: `eslint.config.js` teaches `must-use-result` that a directly-chained `._unsafeUnwrapErr()` — including through an `await` — consumes its Result, so async Err assertions in tests need no per-site disables.
- **Embedder-visible break**: an embedder wiring `SANDBOX_BACKEND=k8s` with `sessionPvc` MUST now also supply `sessionPvcRoot`. The CLI (Docker-only) is unaffected. `stepWritePrefix` is no longer exported from the barrel.
- **Also fixed here**: `sandbox/docker-client.ts` carried an unused `statusCodeOf`, failing `bun run lint` on `main` as well as on this branch.
- **Out of scope**: the `res` claim formula and the Go mirror's shared test vector, both unchanged; whether a managed host's content-server must now map URL space onto workspace roots (tracked as a question for the deployment owner, not a harness change).
