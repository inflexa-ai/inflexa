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

The tree is rooted at the embedder-resolved workspace root (see the
workspace-root-resolution spec); host paths carry no `{resourceId}` segment.
Report previews live inside the tree like every other analysis artifact; the
browser-facing authorization boundary (`previews/{analysisId}/{previewId}`)
is the content-token `res` claim — URL space, not a filesystem path — which a
host that serves previews maps onto the workspace-root storage itself.

## Requirements

### Requirement: Per-analysis workspace tree


Each analysis SHALL have a workspace tree rooted at the embedder-resolved workspace root (`resolveWorkspaceRoot(resourceId)` — see the workspace-root-resolution capability) containing `data/` for immutable input files (per-file directories under `data/inputs/`, staged by the embedder before any run), `runs/` for workflow-run artifacts, `reports/` for flat report output, `previews/` for versioned report previews, and `report-sessions/` for the page of a report session. Host paths carry no `{resourceId}` segment — the resolved root already identifies the resource. The `data/` tree SHALL be treated as read-only by every surface; only a step's own run directory, or one declared session write tail, is writable.

A sandbox write tail is a workspace-relative path that a sandbox creation declares in place of the step directory. Each segment passes the safe-id discipline of the step builder. The session derivation declares `report-sessions/{threadId}/derived`, and the run path declares none, thus the run mounts stay as they are.

#### Scenario: New analysis workspace structure

- **WHEN** an analysis workspace is initialized
- **THEN** the `data/` directory holds the immutable inputs and `runs/` is
  created on demand when the first workflow run starts

#### Scenario: Input files are immutable

- **WHEN** any mutate surface resolves a write whose path falls under
  the workspace root's `data/`
- **THEN** the write SHALL be rejected (it is outside the step's writable
  working directory) and the input bytes SHALL remain unchanged

#### Scenario: A declared write tail is the one writable mount
- **WHEN** a sandbox creation declares a write tail
- **THEN** the container holds the tree read-only and that tail read-write, and no step directory mounts

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

### Requirement: The page of a report session lives under one named directory

The page of a report session and its staged assets MUST live at `{workspaceRoot}/report-sessions/{threadId}/`. The thread id names the directory, thus one session owns one directory and two sessions never collide.

One helper of the workspace paths MUST compose that directory, workspace-root-relative. The preview helpers beside it take the same form, thus a reader meets one shape. Each caller joins the root that it holds already.

The helper MUST assert the thread id, exactly as each sibling path builder asserts its own. An id reaches a path builder from a caller, and one crafted segment climbs out of the root. One rule at every builder beats a judgment for each one.

Each surface that reads or writes the page MUST call the helper, and no surface MUST compose the layout of its own. A path that two modules spell by hand is a layout that a later change breaks in one place alone.

The helper MUST be on the front door of the package. A host that removes the files of a purged session then names each directory through the harness, and it restates no layout.

#### Scenario: The preview writes through the helper

- **WHEN** the preview tool writes the page of a session
- **THEN** the page and its assets land under the directory that the helper gives

#### Scenario: One directory for each session

- **GIVEN** two report sessions of one analysis
- **WHEN** each renders its page
- **THEN** the two pages sit in two directories, and neither overwrites the other

#### Scenario: An embedder reaches the layout through the package

- **WHEN** an embedder removes the page files of a thread that a purge erased
- **THEN** it composes each path with the exported helper, and it spells no directory name
