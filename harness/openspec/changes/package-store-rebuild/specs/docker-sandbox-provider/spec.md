# Delta: docker-sandbox-provider

## ADDED Requirements

### Requirement: Farm resolution comes before the container

When `libStorePath` is configured, `createSandbox` MUST resolve the farm
source before any container work. A resolver throw and an `unavailable`
result MUST refuse the call with the `farm_unavailable` `SandboxError`
variant. The reason of the embedder MUST ride in the error. When the
resolved farm fails the `inflexa.lock` gate, the backend MUST drop both
store mounts, log a warning, and still make the container. The sandbox
then reports the store as unavailable.

#### Scenario: A resolver refusal carries the embedder reason

- **GIVEN** a `per-analysis` farm source whose resolver returns `unavailable` with "the store download is in progress"
- **WHEN** `createSandbox` runs
- **THEN** the call returns a `farm_unavailable` error that carries that reason, and no container is made

#### Scenario: An unusable farm degrades the sandbox

- **GIVEN** a resolved farm whose `inflexa.lock` does not parse
- **WHEN** `createSandbox` runs
- **THEN** the backend makes the container with no `/mnt/libs` mount and no farm mount, and a warning is logged

## MODIFIED Requirements

### Requirement: Bind mounts replace PVCs

The Docker backend MUST bind-mount host directories into the container per
the shared mount plan (`mount-plan.ts`):

- the analysis workspace tree, a flat read-only mount at the plan's
  `readonlyTreePath`
- the per-step writable artifact root, a nested read-write mount at the
  plan's `writableStepPath`, omitted for a read-only sandbox
- the package store at `/mnt/libs`, read-only, when `libStorePath` is
  configured
- the farm of the analysis at the farm container path, read-only, from
  the resolved farm source
- the ref store at `/mnt/refs`, read-only, when `refStorePath` is configured

The farm bind MUST come after the store bind in the bind array, thus the
nesting is stable. Mount host-path sources MUST derive from the resolved
workspace root (`resolveWorkspaceRoot(analysisId)`), not from a global
session base. Each mount's read-only flag is set explicitly in the bind
string.

`buildMountPlan` MUST return only the paths both backends share — container
paths, step subdirs, and env. The K8s `subPath` strings MUST come from
`buildSessionSubPaths(coords, workspaceSubPath)`, because they are a property
of how one backend addresses a volume, not of the container contract.

#### Scenario: Workspace tree mounted read-only

- **GIVEN** an analysis whose workspace root resolves to `{workspaceRoot}`
- **WHEN** the backend makes the container
- **THEN** `{workspaceRoot}` is bind-mounted at the plan's read-only tree path (`/{analysisId}`) with the `:ro` flag

#### Scenario: Library store bind mount

- **GIVEN** a configured `libStorePath` and a resolved farm
- **WHEN** the backend makes the container
- **THEN** the container has a read-only bind at `/mnt/libs` and a read-only farm bind at the farm container path
- **AND** the sandbox env injects the lib-store path variables from the mount plan
