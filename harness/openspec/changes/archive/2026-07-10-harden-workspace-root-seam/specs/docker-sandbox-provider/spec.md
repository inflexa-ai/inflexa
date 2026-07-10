# docker-sandbox-provider Delta

## ADDED Requirements

### Requirement: K8s PVC subPaths derive from the resolved workspace root

The K8s backend addresses the session volume by `subPath`, so it SHALL be able to express a resolved workspace root as a path relative to the volume's root. `K8sClientConfig` SHALL therefore carry the `resolveWorkspaceRoot` seam and `sessionPvcRoot` — the absolute mountpoint of `sessionPvc` on the harness process's own filesystem. Whenever `sessionPvc` is configured, `sessionPvcRoot` SHALL be configured too.

The pod's read-only tree mount SHALL use `subPath = relative(sessionPvcRoot, resolveWorkspaceRoot(analysisId))`, and its read-write step mount SHALL use that path joined with `runs/{runId}/{stepId}`. Because `createSandbox` pre-creates the step tree under `resolveWorkspaceRoot(analysisId)` on the same volume, the directory the harness writes and the directory the pod mounts are then the same one by construction rather than by convention. The backend SHALL NOT derive the `subPath` from `analysisId` alone: that silently mounts a different directory for any embedder whose roots are not laid out as `{pvcRoot}/{analysisId}`.

A resolved root that does not live under `sessionPvcRoot` cannot be addressed as a `subPath` at all. The backend SHALL fail loudly in that case — `createSandbox` runs inside a DBOS workflow body, where a throw is the durable failure signal — rather than mounting a same-named sibling.

#### Scenario: subPath tracks a root that is not `{pvcRoot}/{analysisId}`

- **GIVEN** `sessionPvcRoot` `/sessions` and a resolver mapping `an-1` to `/sessions/tenants/acme/an-1`
- **WHEN** a sandbox is created for `an-1`, run `run-1`, step `step-a`
- **THEN** the read-only session mount has `mountPath: "/an-1"` and `subPath: "tenants/acme/an-1"`
- **AND** the read-write session mount has `mountPath: "/an-1/runs/run-1/step-a"` and `subPath: "tenants/acme/an-1/runs/run-1/step-a"`
- **AND** the container's paths are unchanged — the container never learns where the tree lives

#### Scenario: A root outside the PVC root is rejected

- **GIVEN** `sessionPvcRoot` `/sessions` and a resolver mapping `an-1` to `/elsewhere/an-1`
- **WHEN** a sandbox is created for `an-1`
- **THEN** creation throws, naming the root and the PVC root — no Job is created

#### Scenario: `sessionPvc` without `sessionPvcRoot` is a configuration error

- **GIVEN** `sessionPvc` is set and `sessionPvcRoot` is not
- **WHEN** a sandbox is created
- **THEN** creation throws, because the `subPath` of a workspace root cannot be derived

## MODIFIED Requirements

### Requirement: Bind mounts replace PVCs

The Docker backend SHALL bind-mount host directories into the container per the
shared mount plan (`mount-plan.ts`): the analysis workspace tree (flat read-only
mount at the plan's `readonlyTreePath`), the per-step writable artifact root
(nested read-write mount at the plan's `writableStepPath`, omitted for read-only
sandboxes), the lib store at `/mnt/libs` (read-only, when `libStorePath` is
configured), and the ref store at `/mnt/refs` (read-only, when `refStorePath` is
configured). Mount host-path sources SHALL derive from the resolved workspace
root (`resolveWorkspaceRoot(analysisId)`), not from a global session base. Each
mount's read-only flag is set explicitly in the bind string.

`buildMountPlan` SHALL return only the paths both backends share — container
paths, step subdirs, and env. The K8s `subPath` strings SHALL come from
`buildSessionSubPaths(coords, workspaceSubPath)` instead, since they are a
property of how one backend addresses a volume, not of the container contract.

#### Scenario: Workspace tree mounted read-only

- **GIVEN** an analysis whose workspace root resolves to `{workspaceRoot}`
- **WHEN** the container is created
- **THEN** `{workspaceRoot}` is bind-mounted at the plan's read-only tree path (`/{analysisId}`) with the `:ro` flag

#### Scenario: Library store bind mount

- **GIVEN** a configured `libStorePath`
- **WHEN** the container is created
- **THEN** the container has a read-only bind mount at `/mnt/libs`
- **AND** the sandbox env injects the lib-store path variables from the mount plan
