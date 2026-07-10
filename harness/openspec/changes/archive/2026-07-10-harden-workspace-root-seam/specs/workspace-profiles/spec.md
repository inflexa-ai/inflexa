# workspace-profiles Delta

## REMOVED Requirements

### Requirement: Docker mount builder in mount-strategy

**Reason**: `workspace/mount-strategy.ts` had no importers — neither `buildDockerMounts`, `buildPodMounts`, nor `buildMountPaths` was ever called. The live mount model for both backends is `sandbox/mount-plan.ts` (`buildMountPlan`), which `docker-client.ts` and `k8s-client.ts` each translate into their own mount mechanism. Specifying a module nothing reads made a second, silently divergent source of truth for container paths.

**Migration**: None. `buildMountPlan(coords, stores)` already returns the container-side paths (`readonlyTreePath`, `writableStepPath`, `workingDir`) both backends use; `buildSessionSubPaths(coords, workspaceSubPath)` returns the K8s `subPath`s. A caller wanting Docker bind sources joins `resolveWorkspaceRoot(analysisId)` with the plan's container-relative step tail, which is what `docker-client.ts` does.
