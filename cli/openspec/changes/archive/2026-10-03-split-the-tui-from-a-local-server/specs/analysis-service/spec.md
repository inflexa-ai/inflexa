# analysis-service Delta

## MODIFIED Requirements

### Requirement: Rename moves the analysis workspace

Renaming an analysis regenerates its slug, and the workspace directory is keyed by slug — so the rename action (`renameAnalysisAndMoveWorkspace` in `src/modules/analysis/analysis.ts`) SHALL move `.inflexa/analyses/<old-slug>/` to `.inflexa/analyses/<new-slug>/` in the same deliberate action that updates the row. The row updates first: the row is authoritative and the tree derived, so a crash or failed move leaves a missing tree at the new slug (the healable desync condition) plus a visible leftover at the old slug — never a row pointing at bytes the rename lost. A missing source directory (never created, or user-deleted) SHALL NOT fail the rename — the row updates and the workspace materializes at the new slug on next use, per the local-state desync rule.

The new slug SHALL be computed with the renamed analysis excluded from the collision set (`uniqueSlugForAnchor(anchorId, name, { excludeAnalysisId })`). An analysis MUST NOT collide with its own slug: renaming to the current name — or to any name that slugifies identically — SHALL keep the slug, update only the row's `name`, and move nothing.

The outcome SHALL distinguish three cases rather than collapsing them: the tree moved; there was nothing to move (no tree yet, or an unchanged slug); or a tree may exist and could not be moved. The third case SHALL carry a `moveError` — including when the anchor could not be resolved, which is not the same as "there was no tree" and SHALL NOT be reported as success.

Mid-run renames are NOT excluded by the per-analysis instance lock: that lock excludes other processes, while the analysis's chat turns, data profiles, and durable runs all execute inside the local server process that serves the rename, for each of its clients. The rename route of the local server SHALL therefore establish that the workspace is quiescent before it invokes the rename — no running chat turn, no queued or running data profile, and no run with a live workflow for the analysis — and SHALL refuse the rename with 409 `busy` and the reason when quiescence cannot be established (e.g. the run ledger is unreadable). A client SHALL read the same reasons before it opens a rename dialog, and the server checks again at the rename itself, because no dialog is modal across clients. This is the embedder's half of the harness's workspace-root-resolution contract, which requires a resource's root to be stable for the life of a run.

#### Scenario: Rename moves the directory with the row

- **GIVEN** an idle analysis with slug `batch-42` and an existing workspace containing run artifacts
- **WHEN** the analysis is renamed to "Batch 43"
- **THEN** the row's slug becomes `batch-43` and the same artifacts are now at `.inflexa/analyses/batch-43/`

#### Scenario: Renaming to the current name is a no-op on disk

- **GIVEN** an analysis named "My Analysis" with slug `my-analysis` and a workspace containing run artifacts
- **WHEN** it is renamed to "My Analysis"
- **THEN** its slug is still `my-analysis`, no directory was moved, and no `my-analysis-2` exists

#### Scenario: A name that slugifies identically keeps the slug

- **GIVEN** an analysis named "My Analysis" with slug `my-analysis`
- **WHEN** it is renamed to "my   analysis"
- **THEN** the row's `name` updates, the slug stays `my-analysis`, and no directory was moved

#### Scenario: A sibling's slug still forces a suffix

- **GIVEN** two analyses under one anchor, slugs `taken` and `other`
- **WHEN** the second is renamed to "Taken"
- **THEN** its slug becomes `taken-2`

#### Scenario: A failed directory move is surfaced, not silent

- **WHEN** the row rename succeeds but the directory move fails (e.g. the folder turned read-only)
- **THEN** the outcome reports the move failure so the caller can tell the user where the old tree remains

#### Scenario: An unresolvable anchor is a move failure, not a missing tree

- **WHEN** the row rename succeeds but the analysis's anchor cannot be resolved to a live path
- **THEN** the outcome carries a `moveError` — the tree may exist and its location is unknown

#### Scenario: Missing workspace does not block a rename

- **WHEN** an analysis whose workspace directory does not exist is renamed
- **THEN** the row updates and no error is raised about the missing directory

#### Scenario: A rename is refused while the workspace is in use

- **GIVEN** an analysis with a running chat turn, a running data profile, or a run with a live workflow
- **WHEN** the user invokes the rename command
- **THEN** the command refuses with a reason and opens no dialog

#### Scenario: A rename from a second client is refused while the first client's turn runs

- **GIVEN** a chat turn of one client runs on the analysis
- **WHEN** a second client of the same server sends the rename
- **THEN** the server answers 409 `busy` with the chat turn as the reason, and nothing is renamed or moved
