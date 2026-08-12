# docker-sandbox-provider Delta — Per-Analysis Farm Mount

## MODIFIED Requirements

### Requirement: Bind mounts replace PVCs

The Docker backend SHALL bind-mount host directories into the container per the
shared mount plan (`mount-plan.ts`): the analysis workspace tree (flat read-only
mount at the plan's `readonlyTreePath`), the per-step writable artifact root
(nested read-write mount at the plan's `writableStepPath`, omitted for read-only
sandboxes), the lib store at `/mnt/libs` (read-only, when `libStorePath` is
configured), the analysis farm at `/mnt/libs/current` (read-only, from the
location the farm provider returns for the analysis), and the ref store at
`/mnt/refs` (read-only, when `refStorePath` is configured). Mount host-path
sources SHALL derive from the resolved workspace root
(`resolveWorkspaceRoot(analysisId)`), not from a global session base. Each
mount's read-only flag is set explicitly in the bind string.

The farm bind nests inside the store bind. The backend SHALL order the two so
that the farm mounts after the store. Thus the farm shadows the mount point,
and the farm links resolve through the store bind. A backend test SHALL pin
this ordering, because it is engine behavior and not API contract.

The store usability gate SHALL validate the farm the provider names: the farm
location resolves to a directory that carries `packages.txt` and `meta.json`.
The gate SHALL NOT follow a `current` symlink at the store root. When the gate
fails, the backend SHALL NOT bind the store, and it SHALL NOT bind the farm.
Thus Docker cannot auto-make a root-owned directory at either path.

`buildMountPlan` SHALL return only the paths both backends share — container
paths, step subdirs, and env. The K8s `subPath` strings SHALL come from
`buildSessionSubPaths(coords, workspaceSubPath)` instead, since they are a
property of how one backend addresses a volume, not of the container contract.

#### Scenario: Workspace tree mounted read-only

- **GIVEN** an analysis whose workspace root resolves to `{workspaceRoot}`
- **WHEN** the container is created
- **THEN** `{workspaceRoot}` is bind-mounted at the plan's read-only tree path (`/{analysisId}`) with the `:ro` flag

#### Scenario: Library store bind mount

- **GIVEN** a configured `libStorePath` and a farm the provider names
- **WHEN** the container is created
- **THEN** the container has a read-only bind at `/mnt/libs` and a read-only bind at `/mnt/libs/current`
- **AND** the sandbox env injects the lib-store path variables from the mount plan

#### Scenario: The nested binds resolve together

- **GIVEN** a farm whose links target `/mnt/libs/store/...`
- **WHEN** the container starts with the store bind and the farm bind
- **THEN** a file read through `/mnt/libs/current` resolves, and its link target under `/mnt/libs/store` resolves

#### Scenario: An unusable farm drops both binds

- **GIVEN** a farm location that does not resolve, or a farm without its completeness markers
- **WHEN** the container is created
- **THEN** the backend binds neither `/mnt/libs` nor `/mnt/libs/current`, and it reports the degradation through the diagnostics seam
