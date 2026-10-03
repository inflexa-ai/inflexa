# analysis-service Specification

## Purpose
The analysis lifecycle — create (writable anchor + unique slug + inputs), rename (moves the workspace), add inputs, list, and resolve by id-or-name (with collision surfacing) — composed over the anchor, path-resolution, and DB layers as library-pure functions.

## Requirements

### Requirement: Create an analysis

The system SHALL provide `createAnalysis(opts)` returning `Result<Analysis, WorkspaceError>` (the `DbError` union widened by the actionable `workspace_unavailable` variant) in `src/modules/analysis/analysis.ts` that: ensures `opts.cwd` is a tracked anchor; requires the anchor folder to be writable — a non-writable folder SHALL fail creation with an actionable error before any row is inserted (the workspace at `.inflexa/analyses/<slug>/` is where everything the analysis touches will live, so writability is a precondition of the analysis existing); generates a slug from `opts.name` (kebab-case, lowercased) or a generated handle, unique within the anchor; mints and inserts the `Analysis` with `id = randomUUIDv7()` (inline), `anchorId` = the anchor id, `projectId = opts.projectId ?? null`, `name` the validated `Str256`, and `createdAt`/`updatedAt` timestamps; and adds inputs from `opts.inputPaths` when provided and SHALL NOT enroll any input by default (an omitted/empty `opts.inputPaths` yields an analysis with zero inputs — inputs are user-driven, never the anchor/cwd). There SHALL be no output override (`opts.outputOverride` does not exist) and no persisted output path — the workspace root is always derived from anchor + slug. The `Analysis` SHALL carry no `goals`, `syncedAnalysisId`, or `archivedAt` field.

#### Scenario: Create with a name yields a kebab slug and an anchor

- **WHEN** `createAnalysis({ cwd, name: "Batch 42" })` runs in a fresh directory
- **THEN** the analysis slug is `batch-42`
- **AND** the directory has a marker and an anchors row
- **AND** the analysis has no inputs (none were provided; inputs are never defaulted to the anchor/cwd)

#### Scenario: Duplicate name within an anchor gets a numeric suffix

- **WHEN** a second `createAnalysis({ cwd, name: "Batch 42" })` runs in the same directory
- **THEN** its slug is `batch-42-2`

#### Scenario: Symbol-only name yields a generated handle

- **WHEN** `createAnalysis` is given a name that slugs to empty
- **THEN** the slug is a generated handle (e.g. `analysis-<short>`)

#### Scenario: Non-writable folder fails creation with an actionable error

- **WHEN** `createAnalysis` runs in a folder the process cannot write to
- **THEN** it returns an err whose message names the folder and suggests choosing a writable one
- **AND** no analysis row, marker, or directory was created

### Requirement: Add inputs to an analysis

The system SHALL provide `addInputs(analysisId, rawPaths, cwd)` returning `Result<AnalysisInput[], DbError>` that classifies each raw path via the path-resolution layer, inserts the resulting refs, de-duplicates identical refs (within the batch and against existing inputs), and rejects a non-existent path with a clear error rather than storing a dangling reference.

#### Scenario: Inputs classified and stored

- **WHEN** `addInputs(id, [pathInsideAnchor, absolutePathOutside], cwd)` runs
- **THEN** the inside path is stored as an anchor-relative ref and the outside path as an absolute ref

#### Scenario: Duplicate refs collapse

- **WHEN** the same path is provided twice, or already exists as an input
- **THEN** only one input row results for that ref

#### Scenario: Non-existent path is rejected

- **WHEN** a raw path does not exist on disk
- **THEN** `addInputs` returns an `err` and stores no dangling reference

### Requirement: List analyses for a directory's anchor

The system SHALL provide `listAnalysesForAnchorAt(dir)` returning `Result<Analysis[], DbError>` that finds the nearest marker at or above `dir` and lists the analyses anchored there, returning an empty list when no marker is found.

#### Scenario: Lists analyses anchored at the directory

- **WHEN** `listAnalysesForAnchorAt(dir)` is called where `dir` (or an ancestor) has a marker
- **THEN** it returns the analyses homed at that anchor

#### Scenario: No marker yields an empty list

- **WHEN** no marker exists at or above `dir`
- **THEN** it returns an empty array

### Requirement: List recent analyses

The system SHALL provide `listRecentAnalyses(opts?)` returning `Result<Analysis[], DbError>` that returns analyses for `opts.projectId` when given, otherwise all analyses ordered most-recent-first.

#### Scenario: All recent analyses

- **WHEN** `listRecentAnalyses()` is called with no project
- **THEN** it returns analyses ordered by `createdAt` descending

#### Scenario: Scoped to a project

- **WHEN** `listRecentAnalyses({ projectId })` is called
- **THEN** it returns the analyses for that project

### Requirement: Resolve an analysis by id or name

The system SHALL provide `findAnalysis(ref: IdOrName)` returning `Result<Analysis | null, DbError>` (the single best match: exact id first, else most-recent name/slug), and `matchAnalysis(ref: IdOrName)` returning `Result<AnalysisMatch | null, DbError>` that reshapes the candidate set into `{ analysis, others }` so a caller can surface a name/slug collision. Both resolve through the single id-priority query `findAnalysesByRef`; neither does a read-by-id-then-by-name round trip.

#### Scenario: Find returns the best single match

- **WHEN** `findAnalysis(ref)` matches an id, or a unique name/slug
- **THEN** it returns that analysis, else `null`

#### Scenario: Match surfaces a collision

- **WHEN** `matchAnalysis(ref)` resolves a name that several analyses share (none by id)
- **THEN** it returns `{ analysis, others }` with `others` non-empty so the caller can report the ambiguity

### Requirement: Library purity

The analysis service SHALL NOT print, call `process.exit`, or render any TUI; it returns `Result`s for the CLI/presentation layer to present. There is no archive operation (the data model carries no `archivedAt`).

#### Scenario: No user-facing output

- **WHEN** any analysis-service function is called
- **THEN** it produces no console output and returns a `Result`

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
