# Delta: workspace-layout

## MODIFIED Requirements

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
