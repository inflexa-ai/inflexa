## MODIFIED Requirements

<!-- The body below is the requirement as it stands, and the one change is the
     fifth directory. The rest is copied text, thus it keeps its original wording. -->

### Requirement: Per-analysis workspace tree

Each analysis SHALL have a workspace tree rooted at the embedder-resolved workspace root (`resolveWorkspaceRoot(resourceId)` — see the workspace-root-resolution capability) containing `data/` for immutable input files (per-file directories under `data/inputs/`, staged by the embedder before any run), `runs/` for workflow-run artifacts, `reports/` for flat report output, `previews/` for versioned report previews, and `report-sessions/` for the page of a report session. Host paths carry no `{resourceId}` segment — the resolved root already identifies the resource. The `data/` tree SHALL be treated as read-only by every surface; only a step's own run directory is writable.

#### Scenario: New analysis workspace structure

- **WHEN** an analysis workspace is initialized
- **THEN** the `data/` directory holds the immutable inputs and `runs/` is
  created on demand when the first workflow run starts

#### Scenario: Input files are immutable

- **WHEN** any mutate surface resolves a write whose path falls under
  the workspace root's `data/`
- **THEN** the write SHALL be rejected (it is outside the step's writable
  working directory) and the input bytes SHALL remain unchanged

## ADDED Requirements

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
