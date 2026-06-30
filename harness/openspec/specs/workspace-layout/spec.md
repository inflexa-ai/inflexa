# workspace-layout Specification

## Purpose

Define the on-disk workspace layout the harness owns for each analysis — the
single directory tree under which input data, workflow-run artifacts, and report
output live. The layout is the physical counterpart to the frame-aware path
model: the canonical resolver (`workspace/paths.ts`) maps every agent-supplied
path into this tree, and the sandbox mount strategy mirrors it (full analysis
tree mounted read-only at `/{resourceId}`, the active step's directory mounted
read-write at `/{resourceId}/runs/{runId}/{stepId}`). Because the structure is
derived in one module, a file a step writes is read back by the read surface at
the identical path, and the same path teaching holds in prompts, tools, and the
scripts agents run.

Report previews are deliberately rooted *outside* the per-analysis tree, under a
top-level `previews/` directory, because they are the only workspace content
served directly to a browser through a short-lived content token; keeping them
under `previews/{analysisId}/{previewId}` makes `previews/{analysisId}` the
authorization boundary the content-server enforces, and lets the version layout
evolve without touching the analysis data tree.

## Requirements

### Requirement: Per-analysis workspace tree

Each analysis SHALL have a workspace tree rooted at `{resourceId}/` containing
`{resourceId}/data/` for immutable input files (per-file directories under
`data/inputs/`, staged by the embedder before any run), `{resourceId}/runs/` for
workflow-run artifacts, and `{resourceId}/reports/` for flat report output. The
`data/` tree SHALL be treated as read-only by every surface; only a step's own
run directory is writable.

#### Scenario: New analysis workspace structure

- **WHEN** an analysis workspace is initialized
- **THEN** the `data/` directory holds the immutable inputs and `runs/` is
  created on demand when the first workflow run starts

#### Scenario: Input files are immutable

- **WHEN** any mutate surface resolves a write whose path falls under
  `{resourceId}/data/`
- **THEN** the write SHALL be rejected (it is outside the step's writable
  working directory) and the input bytes SHALL remain unchanged

### Requirement: Run and step directory structure

A workflow run SHALL create `{resourceId}/runs/{runId}/` and, per sandbox-agent
step, a step directory `{resourceId}/runs/{runId}/{stepId}/`. Each step
directory SHALL carry the artifact subdirectories `scripts/`, `output/`,
`figures/`, `logs/`, and `notebooks/`. The step directory is the agent's
writable working directory: relative paths resolve against it and writes are
confined to it.

#### Scenario: Workflow run creates scoped step directories

- **WHEN** a workflow run starts and a step begins
- **THEN** `runs/{runId}/{stepId}/` SHALL exist with its `scripts/`, `output/`,
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

### Requirement: Versioned report previews live under the previews root

Iterative report previews SHALL be stored under a top-level `previews/` tree at
`previews/{analysisId}/{previewId}/v{N}`, where `previewId` groups all versions
of one preview and `N` is a positive, monotonically increasing version number.
The path SHALL be produced by the single shared formula (`previewResourceId` /
`previewVersionDir`) so the directory path, the content-token `res` claim, and
the served URL all agree. Shared assets SHALL live once at the preview root
(`previews/{analysisId}/{previewId}/assets/`) and be referenced from each
version directory; `previews/{analysisId}` SHALL be the authorization boundary.

#### Scenario: Report version directory structure

- **WHEN** a report iteration creates version N for preview `prv-abc` of analysis
  `A`
- **THEN** the directory `previews/A/prv-abc/v{N}/` SHALL exist and contain the
  report template source (`report.html.j2`) and the built output (`index.html`),
  with an `assets/` entry resolving to the shared preview-root assets

#### Scenario: Versions are independent and monotonic

- **WHEN** a new iteration runs against an existing preview
- **THEN** the new version number SHALL be one greater than the highest existing
  `v{N}` directory, and prior version directories SHALL remain unchanged

#### Scenario: Preview path matches the content-token claim

- **WHEN** a preview URL is minted for `previews/{analysisId}/{previewId}`
- **THEN** the on-disk directory, the token `res` claim, and the served URL
  SHALL all derive from `previews/{analysisId}/{previewId}` via the one shared
  formula, so the content-server authorizes and resolves the same path

### Requirement: Flat report output directory

The canonical flat report-output directory for an analysis SHALL be
`{resourceId}/reports/{reportId}`, produced by `reportDir(resourceId,
reportId)`. This path is part of the per-analysis tree (distinct from the
browser-served `previews/` root) and is validated so `resourceId` and `reportId`
cannot contain path-traversal characters.

#### Scenario: Report directory resolves under the analysis tree

- **WHEN** `reportDir(resourceId, reportId)` is computed
- **THEN** it SHALL return `{resourceId}/reports/{reportId}` under the analysis
  tree, and SHALL reject ids that are not safe path segments
