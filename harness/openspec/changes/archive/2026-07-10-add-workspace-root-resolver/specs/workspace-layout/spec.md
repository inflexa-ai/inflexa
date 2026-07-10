# workspace-layout Delta

## MODIFIED Requirements

### Requirement: Per-analysis workspace tree

Each analysis SHALL have a workspace tree rooted at the embedder-resolved workspace root (`resolveWorkspaceRoot(resourceId)` — see the workspace-root-resolution capability) containing `data/` for immutable input files (per-file directories under `data/inputs/`, staged by the embedder before any run), `runs/` for workflow-run artifacts, `reports/` for flat report output, and `previews/` for versioned report previews. Host paths carry no `{resourceId}` segment — the resolved root already identifies the resource. The `data/` tree SHALL be treated as read-only by every surface; only a step's own run directory is writable.

#### Scenario: New analysis workspace structure

- **WHEN** an analysis workspace is initialized
- **THEN** the `data/` directory holds the immutable inputs and `runs/` is
  created on demand when the first workflow run starts

#### Scenario: Input files are immutable

- **WHEN** any mutate surface resolves a write whose path falls under
  the workspace root's `data/`
- **THEN** the write SHALL be rejected (it is outside the step's writable
  working directory) and the input bytes SHALL remain unchanged

### Requirement: Run and step directory structure

A workflow run SHALL create `{workspaceRoot}/runs/{runId}/` and, per sandbox-agent
step, a step directory `{workspaceRoot}/runs/{runId}/{stepId}/`. Each step
directory SHALL carry the artifact subdirectories `scripts/`, `output/`,
`figures/`, `logs/`, and `notebooks/`. The step directory is the agent's
writable working directory: relative paths resolve against it and writes are
confined to it.

#### Scenario: Workflow run creates scoped step directories

- **WHEN** a workflow run starts and a step begins
- **THEN** `runs/{runId}/{stepId}/` SHALL exist under the workspace root with its `scripts/`, `output/`,
  `figures/`, `logs/`, and `notebooks/` subdirectories available for artifacts

#### Scenario: Multiple runs coexist

- **WHEN** multiple runs complete for the same analysis
- **THEN** each run SHALL have its own `runs/{runId}/` directory with
  independent per-step outputs

#### Scenario: Reserved subdir names cannot be step ids

- **WHEN** a plan assigns a step an id equal to a reserved artifact-subdir name
  (`scripts`, `output`, `figures`, `logs`, or `notebooks`, case-insensitively)
- **THEN** plan validation SHALL reject the plan, because the step directory
  would collide with the artifact-subdirectory convention

### Requirement: Flat report output directory

The canonical flat report-output directory for an analysis SHALL be
`{workspaceRoot}/reports/{reportId}`, produced by `reportDir(...)` joined onto the
resolved workspace root. This path is part of the per-analysis tree and is
validated so `reportId` cannot contain path-traversal characters.

#### Scenario: Report directory resolves under the analysis tree

- **WHEN** the report directory for `reportId` is computed
- **THEN** it SHALL return `reports/{reportId}` under the resolved workspace
  root, and SHALL reject ids that are not safe path segments

## REMOVED Requirements

### Requirement: Versioned report previews live under the previews root

**Reason**: Previews are user-generated analysis content and belong inside the analysis workspace tree like every other artifact. Their out-of-tree placement served an HTTP authorization boundary that is a URL-space concept, not a filesystem one — the `previewResourceId` token claim formula survives unchanged.
**Migration**: Replaced by "Versioned report previews live inside the analysis workspace" below. Hosts that serve previews map the unchanged URL claim (`previews/{analysisId}/{previewId}`) onto the new storage location through their `resolveWorkspaceRoot` realization.

## ADDED Requirements

### Requirement: Versioned report previews live inside the analysis workspace

Iterative report previews SHALL be stored inside the analysis workspace tree at `{workspaceRoot}/previews/{previewId}/v{N}`, where `previewId` groups all versions of one preview and `N` is a positive, monotonically increasing version number. Shared assets SHALL live once at the preview root (`{workspaceRoot}/previews/{previewId}/assets/`) and be referenced from each version directory. The content-token `res` claim SHALL remain `previews/{analysisId}/{previewId}` (the `previewResourceId` formula, unchanged): it is URL space, no longer a filesystem sub-path, and a host that serves previews SHALL map it onto the workspace-root storage location itself.

#### Scenario: Report version directory structure

- **WHEN** a report iteration creates version N for preview `prv-abc` of analysis `A`
- **THEN** the directory `{workspaceRoot of A}/previews/prv-abc/v{N}/` SHALL exist and contain the report template source (`report.html.j2`) and the built output (`index.html`), with an `assets/` entry resolving to the shared preview-root assets

#### Scenario: Versions are independent and monotonic

- **WHEN** a new iteration runs against an existing preview
- **THEN** the new version number SHALL be one greater than the highest existing `v{N}` directory, and prior version directories SHALL remain unchanged

#### Scenario: URL claim is decoupled from storage

- **WHEN** a preview URL is minted for analysis `A`, preview `prv-abc`
- **THEN** the token `res` claim SHALL be `previews/A/prv-abc` regardless of where `A`'s workspace root lives on disk
