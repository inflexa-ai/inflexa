# analysis-service Delta

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Rename moves the analysis workspace

Renaming an analysis regenerates its slug, and the workspace directory is keyed by slug — so the rename action (`renameAnalysisAndMoveWorkspace` in `src/modules/analysis/analysis.ts`) SHALL move `.inflexa/analyses/<old-slug>/` to `.inflexa/analyses/<new-slug>/` in the same deliberate action that updates the row. The row updates first: the row is authoritative and the tree derived, so a crash or failed move leaves a missing tree at the new slug (the healable desync condition) plus a visible leftover at the old slug — never a row pointing at bytes the rename lost; a failed move SHALL be reported to the caller (`workspaceMoved`/`moveError`), not silently dropped. Mid-run renames are excluded structurally: the only rename surface lives in the TUI process that holds the analysis's per-analysis instance lock, so no other process can rename an analysis with an active run or open chat. A missing source directory (never created, or user-deleted) SHALL NOT fail the rename — the row updates and the workspace materializes at the new slug on next use, per the local-state desync rule.

#### Scenario: Rename moves the directory with the row

- **GIVEN** an idle analysis with slug `batch-42` and an existing workspace containing run artifacts
- **WHEN** the analysis is renamed to "Batch 43"
- **THEN** the row's slug becomes `batch-43` and the same artifacts are now at `.inflexa/analyses/batch-43/`

#### Scenario: A failed directory move is surfaced, not silent

- **WHEN** the row rename succeeds but the directory move fails (e.g. the folder turned read-only)
- **THEN** the outcome reports the move failure so the caller can tell the user where the old tree remains

#### Scenario: Missing workspace does not block a rename

- **WHEN** an analysis whose workspace directory does not exist is renamed
- **THEN** the row updates and no error is raised about the missing directory
