## Purpose

Defines the per-step workspace construction in the harness — the mount strategy (nested RO analysis tree + RW step root), the central `WorkspaceFilesystem` seam, and the vector-index discipline (the workflow body is the sole writer; sandbox agents do not call any index tool).

## Requirements

### Requirement: Pod mount specs use nested RO/RW


`buildPodMounts` SHALL return exactly two pod volumeMount specs: one read-only mount for the full analysis tree at `/{analysisId}/` and one read-write mount for the step at `/{analysisId}/runs/{runId}/{stepId}/`. K8s handles nested mounts — the most-specific path wins.

When `SANDBOX_BACKEND=docker`, `buildDockerMounts` SHALL return the equivalent as Docker bind mount specs: `{ hostPath, containerPath, readOnly }[]`. The host paths are derived from the analysis's resolved workspace root + the tree-relative subpaths.

#### Scenario: Pod has nested mounts (K8s)

- **WHEN** `buildPodMounts({ resourceId, runId, stepId })` is called
- **THEN** it returns two entries: `{ mountPath: /{analysisId}/, readOnly: true }` and `{ mountPath: /{analysisId}/runs/{runId}/{stepId}/, readOnly: false }`

#### Scenario: Docker has nested bind mounts

- **WHEN** `buildDockerMounts({ resourceId, runId, stepId, workspaceRoot })` is called
- **THEN** it returns two entries mapping host paths under `workspaceRoot` to the same container paths with the same read-only flags

### Requirement: Workflow is the sole writer of per-analysis vector index entries


The per-analysis pgvector search index (`search_<analysisId>` table) SHALL be written only by workflow-owned code paths: the executeAnalysis parent workflow (step outputs, step summary, run synthesis) and the data-profile fire-and-forget task (input files, profile summary). Sandbox agents SHALL NOT have any index tool available — there is no agent-callable index tool in the central registry.

#### Scenario: Sandbox agents have no index tool

- **WHEN** a sandbox agent's tool array is inspected
- **THEN** no tool with an indexing capability is present

#### Scenario: Sandbox search remains read-only but functional

- **WHEN** a sandbox agent mid-step calls `workspace_search`
- **THEN** the search tool resolves against the existing vector index
- **AND** returns results written by the workflow from prior steps

### Requirement: Vector index metadata SHALL include a `type` discriminator


Every row written into the per-analysis pgvector index SHALL have a `type` field in its `metadata` JSONB column, taking one of: `"input"`, `"output"`, `"summary"`, `"synthesis"`, `"profile"`. Writers that fail to set `type` SHALL be considered bugs.

#### Scenario: Step output indexing writes type:"output"

- **WHEN** the executeAnalysis child workflow indexes a file description for a completed step
- **THEN** the metadata includes `type: "output"`
- **AND** downstream filtered searches (`type IN ('output')`) return the row

#### Scenario: Step summary indexing writes type:"summary"

- **WHEN** the executeAnalysis child workflow indexes a `summary.md` for a completed step
- **THEN** the metadata includes `type: "summary"`, plus `stepId`, `runId`, `agentId`

#### Scenario: Run synthesis indexing writes type:"synthesis"

- **WHEN** the parent's synthesis step indexes the run synthesis
- **THEN** the metadata includes `type: "synthesis"`, plus `runId`

#### Scenario: Input and profile indexing carry their types

- **WHEN** the data-profile task indexes input files and the profile summary
- **THEN** input file metadata includes `type: "input"`
- **AND** profile summary metadata includes `type: "profile"`

### Requirement: Summary markdown indexing uses raw markdown as embedding text


When the workflow indexes a step's `summary.md`, the embedding SHALL be computed from the raw markdown body (no field concatenation, no TL;DR extraction). Metadata SHALL include `type: "summary"`, `stepId`, `runId`, `agentId`, and `path` (the relative artifact path).

#### Scenario: Embedding text is the markdown body

- **WHEN** the workflow reads `output/summary.md` and indexes it
- **THEN** the text passed to the embedder is the full markdown file contents

#### Scenario: Metadata captures provenance

- **WHEN** the summary vector is upserted
- **THEN** `metadata` includes `{ text: <markdown>, type: "summary", stepId, runId, agentId, path: "runs/{runId}/{stepId}/output/summary.md" }`

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

### Requirement: Docker mount builder in mount-strategy


`harness/workspace/mount-strategy.ts` SHALL export `buildDockerMounts()` alongside `buildPodMounts()`. It SHALL accept `{ resourceId, runId, stepId, workspaceRoot }` — where `workspaceRoot` is the analysis's resolved workspace root — and return `DockerMount[]` with `hostPath` (absolute host directory path), `containerPath` (container mount path), and `readOnly` (boolean).

#### Scenario: Docker mounts derive host paths from the workspace root

- **GIVEN** workspaceRoot `"/home/u/proj/.inflexa/analyses/abc"` and resourceId `"abc123"`
- **WHEN** `buildDockerMounts({ resourceId: "abc123", runId: "run-01", stepId: "de", workspaceRoot })` is called
- **THEN** it returns:
  - `{ hostPath: "/home/u/proj/.inflexa/analyses/abc", containerPath: "/abc123", readOnly: true }`
  - `{ hostPath: "/home/u/proj/.inflexa/analyses/abc/runs/run-01/de", containerPath: "/abc123/runs/run-01/de", readOnly: false }`
