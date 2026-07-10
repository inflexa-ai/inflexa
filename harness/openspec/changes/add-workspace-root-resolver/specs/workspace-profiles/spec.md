# workspace-profiles Delta

## MODIFIED Requirements

### Requirement: Pod mount specs use nested RO/RW

`buildPodMounts` SHALL return exactly two pod volumeMount specs: one read-only mount for the full analysis tree at `/{analysisId}/` and one read-write mount for the step at `/{analysisId}/runs/{runId}/{stepId}/`. K8s handles nested mounts — the most-specific path wins.

When `SANDBOX_BACKEND=docker`, `buildDockerMounts` SHALL return the equivalent as Docker bind mount specs: `{ hostPath, containerPath, readOnly }[]`. The host paths are derived from the analysis's resolved workspace root + the tree-relative subpaths.

#### Scenario: Pod has nested mounts (K8s)

- **WHEN** `buildPodMounts({ resourceId, runId, stepId })` is called
- **THEN** it returns two entries: `{ mountPath: /{analysisId}/, readOnly: true }` and `{ mountPath: /{analysisId}/runs/{runId}/{stepId}/, readOnly: false }`

#### Scenario: Docker has nested bind mounts

- **WHEN** `buildDockerMounts({ resourceId, runId, stepId, workspaceRoot })` is called
- **THEN** it returns two entries mapping host paths under `workspaceRoot` to the same container paths with the same read-only flags

### Requirement: Docker mount builder in mount-strategy

`harness/workspace/mount-strategy.ts` SHALL export `buildDockerMounts()` alongside `buildPodMounts()`. It SHALL accept `{ resourceId, runId, stepId, workspaceRoot }` — where `workspaceRoot` is the analysis's resolved workspace root — and return `DockerMount[]` with `hostPath` (absolute host directory path), `containerPath` (container mount path), and `readOnly` (boolean).

#### Scenario: Docker mounts derive host paths from the workspace root

- **GIVEN** workspaceRoot `"/home/u/proj/.inflexa/analyses/abc"` and resourceId `"abc123"`
- **WHEN** `buildDockerMounts({ resourceId: "abc123", runId: "run-01", stepId: "de", workspaceRoot })` is called
- **THEN** it returns:
  - `{ hostPath: "/home/u/proj/.inflexa/analyses/abc", containerPath: "/abc123", readOnly: true }`
  - `{ hostPath: "/home/u/proj/.inflexa/analyses/abc/runs/run-01/de", containerPath: "/abc123/runs/run-01/de", readOnly: false }`

### Requirement: Sandbox factory selects backend

`createSandboxClient(config)` (`harness/sandbox/create-sandbox.ts`) SHALL read `SANDBOX_BACKEND` from env config and wire either `createK8sSandboxOps` or `createDockerSandboxOps`. The factory is the sole place where the backend decision is made.

#### Scenario: Docker backend selected

- **GIVEN** `SANDBOX_BACKEND=docker`
- **WHEN** `createSandboxClient(...)` is invoked
- **THEN** it wires `createDockerSandboxOps` with bind mounts derived from the `resolveWorkspaceRoot` seam

#### Scenario: K8s backend selected

- **GIVEN** `SANDBOX_BACKEND=k8s`
- **WHEN** `createSandboxClient(...)` is invoked
- **THEN** it wires `createK8sSandboxOps` with PVC mounts derived from the configured PVC names
