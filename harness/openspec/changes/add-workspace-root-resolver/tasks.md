# Tasks — add-workspace-root-resolver

## 1. Seam and path model

- [x] 1.1 Define the `resolveWorkspaceRoot(resourceId) → string` seam type (per design D1: synchronous, injective, durable-state-backed; JSDoc carries the contract) and export it from `src/index.ts` beside the other capability seams
- [x] 1.2 Rework `workspace/paths.ts`: `analysisDataDir`/`runDir`/`runStepDir`/`reportDir` return tree-relative paths (no `{resourceId}/` prefix); `toSandboxPath` and the container→host resolve direction use the `"/" + resourceId + "/" + relative(workspaceRoot, hostPath)` formula; preview dirs become `previews/{previewId}/v{N}` under the root (`previewResourceId` in `contracts/content-url.ts` untouched — URL space only)
- [x] 1.3 Update `resolveWorkspacePath` (frame-aware resolution) to bound against the resolved workspace root; keep the `out_of_scope` data-variant contract

## 2. Sandbox and mounts

- [x] 2.1 `sandbox/create-sandbox.ts`: replace `CreateSandboxClientConfig.sessionsBasePath` with the resolver; `precreateStepTree` derives from `resolveWorkspaceRoot(analysisId)`
- [x] 2.2 `workspace/mount-strategy.ts`: `buildDockerMounts` accepts `{ resourceId, runId, stepId, workspaceRoot }`; K8s `buildPodMounts` subPaths computed relative to the PVC root the resolver's results live under
- [x] 2.3 `sandbox/docker-client.ts`: bind sources `${workspaceRoot}:/{analysisId}:ro` and `${workspaceRoot}/runs/{runId}/{stepId}:…:rw`

## 3. Workflow and pipeline consumers

- [x] 3.1 `workflows/execute-analysis.ts` `init-run-filesystem`: mkdir `join(resolveWorkspaceRoot(analysisId), runDir(runId))`; resolution failures cross DBOS as throws (design D2, `unwrapOrThrow` where Result-based)
- [x] 3.2 `tools/workspace/mutator.ts`: `WorkspaceMutatorDeps` takes the resolver; `resolveForWrite` confinement unchanged in behavior
- [x] 3.3 `execution/post-step-pipeline.ts`: summary write + `reconcileManifestWithDisk`/`fillInputHashesFromDisk` bounds use `{workspaceRoot}` per the artifact-manifest delta
- [x] 3.4 `execution/run-synthesis.ts` + `app/synthesize-run.ts`: synthesis persist under the resolved root
- [x] 3.5 `tasks/data-profile.ts`: input registration paths and the `runs/data-profile/profile` scratch prefix derive from the resolver; cleanup unchanged
- [x] 3.6 `workspace/filesystem.ts`: `WorkspaceFilesystemDeps` takes the resolver; presigned-fallback behavior unchanged

## 4. Reports and previews

- [x] 4.1 `execution/report-runner.ts` + `tools/iterate-report.ts`: preview root/version dirs under `{workspaceRoot}/previews/{previewId}`; `withPreviewLock`, rollback, and shared-assets behavior unchanged
- [x] 4.2 `tools/report/version-fs.ts` + `tools/lib/report-preflight.ts`: confinement and asset staging against the new preview location; fold `previewsForAnalysis` away if nothing needs the listing (design: implementer's call)

## 5. Composition root and public surface

- [x] 5.1 `runtime/assemble.ts`: accept the resolver in `assembleCoreRuntime` deps and thread it to every consumer; remove `sessionsBasePath` from all dep types (compiler enumerates the rest)
- [x] 5.2 Sweep for residual `sessionsBasePath`/`sessionPath`/`SESSION_PATH` references (types, env docs, prompts) — the names die with the concept

## 6. Verification and docs

- [x] 6.1 Update unit tests: `workspace/paths` (incl. the preview-res shared test vector still passing untouched), `mount-strategy`, `report-runner`, mutator confinement, post-step reconcile
- [x] 6.2 Update `harness/CLAUDE.md` (Storage Layout section: root = embedder-resolved workspace root; previews in-tree) and `CONTEXT.md` glossary ("workspace root" replaces "session tree")
- [x] 6.3 `tsc -p tsconfig.json` and `bun test` green; `bun run format:file` on touched sources
