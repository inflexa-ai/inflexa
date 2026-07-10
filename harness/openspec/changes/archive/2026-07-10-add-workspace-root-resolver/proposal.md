# Add workspace-root resolution seam

## Why

The harness locates every analysis workspace by joining a single, process-global `sessionsBasePath` string with the resource id (`{sessionsBasePath}/{resourceId}/…`). That string is closed over at DBOS workflow registration, so the workspace location is one fixed base for every resource a process ever touches — an embedder cannot place different analyses' trees in different places (e.g. the CLI placing each analysis's files beside the user's own data, under its anchor folder). The base-as-value design forces embedders to point users at a location their artifacts never reach (inf-cli#54).

## What Changes

- **New capability seam**: `resolveWorkspaceRoot(resourceId) → absolute host path`, a construction-time dependency registered once per process (satisfying the DBOS single-registration constraint that motivated the global base — the closed-over *function* is fixed; its *result* varies per resource). The returned path IS the analysis tree root: `{workspaceRoot}/data`, `{workspaceRoot}/runs/{runId}/{stepId}`, `{workspaceRoot}/reports`.
- **BREAKING**: `sessionsBasePath` is removed from every dependency surface (`CreateSandboxClientConfig`, `WorkspaceMutatorDeps`, `PostStepPipelineDeps`, `DataProfileDeps`, `WorkspaceFilesystemDeps`, synthesis and report deps, `buildDockerMounts`). All path derivation goes through the resolver. The `{resourceId}/` path segment disappears from host paths — the resolver's result already identifies the resource.
- **BREAKING**: report previews move from the top-level `previews/{analysisId}/{previewId}/v{N}` tree into the analysis workspace at `{workspaceRoot}/previews/{previewId}/v{N}`. The `previewResourceId` URL claim formula (`previews/{analysisId}/{previewId}`) is unchanged — it is URL-space, no longer a filesystem sub-path.
- Container-side paths are **unchanged**: sandboxes still mount the tree at `/{resourceId}` with the RW step mount nested inside — bind mounts decouple host location from container location, so the sandbox protocol, the Go server, and prompts are untouched.
- No backwards compatibility: there are no deployed embedders; the previous layout is deleted, not migrated.

## Capabilities

### New Capabilities
- `workspace-root-resolution`: the embedder-supplied seam that maps a resource id to the absolute host directory of that resource's workspace tree; the harness owns the layout inside the root, the embedder owns where the root lives.

### Modified Capabilities
- `workspace-layout`: the tree is rooted at the embedder-resolved workspace root instead of `{globalBase}/{resourceId}/`; previews relocate into the tree.
- `harness-workspace-tools`: workspace filesystem deps take the resolver instead of `sessionsBasePath`; path bounding is against the resolved root.
- `docker-sandbox-provider`: bind-mount host sources derive from the resolved root instead of `${sessionsBasePath}/${analysisId}`.
- `workspace-profiles`: `buildDockerMounts` accepts the resolved workspace root instead of `sessionPath`.
- `artifact-manifest`: the absolute step path formula becomes `{workspaceRoot}/runs/{runId}/{stepId}/{path}`; host-side bounding is against the resolved root.
- `iterative-report`: preview version directories live under the analysis workspace root.

## Impact

- **Code**: `workspace/paths.ts` (root joins, `toSandboxPath`, preview dirs), `sandbox/create-sandbox.ts`, `sandbox/docker-client.ts`, `workspace/mount-strategy.ts`, `tools/workspace/mutator.ts`, `execution/post-step-pipeline.ts`, `execution/run-synthesis.ts` / `app/synthesize-run.ts`, `tasks/data-profile.ts`, `tools/iterate-report.ts` / `execution/report-runner.ts`, `workspace/filesystem.ts`, `runtime/assemble.ts` (the new dep threads through the composition root).
- **Embedders**: every embedder must supply `resolveWorkspaceRoot` at its composition root. The CLI's realization is the paired `cli` change `unify-analysis-workspace`; a managed deployment realizes it as its PVC path (e.g. `/sessions/{analysisId}`) and adjusts its content server's filesystem mapping for the relocated previews (URL space unchanged).
- **Out of scope**: Postgres/DBOS storage, the sandbox image, the exec protocol, container-side paths.
