# analysis-service Delta

## MODIFIED Requirements

### Requirement: Rename moves the analysis workspace

Renaming an analysis regenerates its slug, and the workspace directory is keyed by slug — so the rename action (`renameAnalysisAndMoveWorkspace` in `src/modules/analysis/analysis.ts`) SHALL move `.inflexa/analyses/<old-slug>/` to `.inflexa/analyses/<new-slug>/` in the same deliberate action that updates the row. The row updates first: the row is authoritative and the tree derived, so a crash or failed move leaves a missing tree at the new slug (the healable desync condition) plus a visible leftover at the old slug — never a row pointing at bytes the rename lost. A missing source directory (never created, or user-deleted) SHALL NOT fail the rename — the row updates and the workspace materializes at the new slug on next use, per the local-state desync rule.

The new slug SHALL be computed with the renamed analysis excluded from the collision set (`uniqueSlugForAnchor(anchorId, name, { excludeAnalysisId })`). An analysis MUST NOT collide with its own slug: renaming to the current name — or to any name that slugifies identically — SHALL keep the slug, update only the row's `name`, and move nothing.

The outcome SHALL distinguish three cases rather than collapsing them: the tree moved; there was nothing to move (no tree yet, or an unchanged slug); or a tree may exist and could not be moved. The third case SHALL carry a `moveError` — including when the anchor could not be resolved, which is not the same as "there was no tree" and SHALL NOT be reported as success.

Mid-run renames are NOT excluded by the per-analysis instance lock: that lock excludes other processes, while the analysis's chat turns, data profiles, and durable runs all execute inside the TUI process that offers the rename. The caller SHALL therefore establish that the workspace is quiescent before invoking the rename — no streaming chat turn, no queued or running data profile, and no non-terminal run row for the analysis — and SHALL refuse the rename when quiescence cannot be established (e.g. the run ledger is unreadable). This is the embedder's half of the harness's workspace-root-resolution contract, which requires a resource's root to be stable for the life of a run.

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

- **GIVEN** an analysis with a streaming chat turn, a running data profile, or a non-terminal run row
- **WHEN** the user invokes the rename command
- **THEN** the command refuses with a reason and opens no dialog

## ADDED Requirements

### Requirement: Deleting an analysis retires its workspace

Deleting the analysis row SHALL NOT be the whole of deleting an analysis. The slug keys the workspace directory and `uniqueSlugForAnchor` hands a freed slug to the next analysis of the same name under the same anchor, so a tree left at `.inflexa/analyses/<slug>/` would be inherited by that successor — its `runs/`, `previews/`, `reports/`, and signed provenance exports appearing under an analysis that never produced them. The system SHALL therefore move the tree out of `analyses/` as part of the deletion.

The system SHALL provide `disposeWorkspace(analysis, mode)` in `src/modules/analysis/output.ts` returning `Result<WorkspaceDisposal, WorkspaceError>`, where `mode` is `"archive"` or `"delete"`, and `WorkspaceDisposal` is `{ kind: "archived"; path }`, `{ kind: "deleted"; path }`, or `{ kind: "absent" }`. `"archive"` SHALL move the tree to `archivedOutputSubdir(slug)` (`.inflexa/analyses_archived/<slug>`), suffixing `-2`, `-3`, … when that destination is taken, so archiving a reused slug never clobbers an earlier archive. `"delete"` SHALL remove the tree. A tree that does not exist — never created, already removed, or living inside an anchor folder that can no longer be located — SHALL be `absent`, not an error.

The delete flow SHALL ask the user which mode to use, defaulting to keeping the files, and SHALL run the disposal BEFORE deleting the row: the filesystem operation is the one that realistically fails, and attempting it first means such a failure leaves both the row and the tree untouched. A failed disposal SHALL abort the deletion and say so. Deletion SHALL be gated on the same workspace-quiescence predicate as rename.

#### Scenario: Archiving keeps the artifacts and frees the slug

- **GIVEN** an analysis with slug `trial` whose workspace contains `runs/run-1/result.csv`
- **WHEN** it is deleted with the files kept
- **THEN** `.inflexa/analyses/trial/` no longer exists
- **AND** `.inflexa/analyses_archived/trial/runs/run-1/result.csv` does

#### Scenario: A recreated analysis of the same name gets a clean tree

- **GIVEN** analysis "Trial" was deleted (files kept or deleted) in a folder
- **WHEN** a new analysis "Trial" is created in that folder
- **THEN** its slug is `trial`, it resolves to the same workspace root, and that root contains none of the previous analysis's artifacts

#### Scenario: Archiving the same slug twice does not clobber

- **GIVEN** `.inflexa/analyses_archived/trial/` already exists
- **WHEN** another analysis with slug `trial` is deleted with the files kept
- **THEN** its tree is archived at `.inflexa/analyses_archived/trial-2/` and the first archive is untouched

#### Scenario: Permanent deletion removes the tree

- **WHEN** an analysis is deleted with the files deleted
- **THEN** neither `.inflexa/analyses/<slug>/` nor an archive of it exists

#### Scenario: A failed disposal aborts the deletion

- **WHEN** the workspace tree cannot be moved or removed
- **THEN** the analysis row is NOT deleted, and the user is told nothing was lost

#### Scenario: A never-created workspace deletes cleanly

- **WHEN** an analysis that was never opened is deleted
- **THEN** the disposal reports `absent` and the row is deleted
