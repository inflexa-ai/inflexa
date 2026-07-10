# docker-sandbox-provider Delta

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

#### Scenario: Workspace tree mounted read-only

- **GIVEN** an analysis whose workspace root resolves to `{workspaceRoot}`
- **WHEN** the container is created
- **THEN** `{workspaceRoot}` is bind-mounted at the plan's read-only tree path (`/{analysisId}`) with the `:ro` flag

#### Scenario: Library store bind mount

- **GIVEN** a configured `libStorePath`
- **WHEN** the container is created
- **THEN** the container has a read-only bind mount at `/mnt/libs`
- **AND** the sandbox env injects the lib-store path variables from the mount plan
