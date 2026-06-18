## ADDED Requirements

### Requirement: Create an analysis

The system SHALL provide `createAnalysis(opts)` returning `Result<Analysis, DbError>` in `src/modules/analysis/analysis.ts` that: ensures `opts.cwd` is a tracked anchor; generates a slug from `opts.name` (kebab-case, lowercased) or a generated handle, unique within the anchor; mints and inserts the `Analysis` with `id = randomUUIDv7()` (inline), `anchorId` = the anchor id, `projectId = opts.projectId ?? null`, `name` the validated `Str256`, `outputDirectory` from `opts.outputOverride` resolved to absolute else null, and `createdAt`/`updatedAt` timestamps; adds inputs from `opts.inputPaths` (defaulting to the anchor directory itself when none); and persists the output directory onto `outputDirectory` when it resolves to the XDG fallback. The `Analysis` SHALL carry no `goals`, `syncedAnalysisId`, or `archivedAt` field.

#### Scenario: Create with a name yields a kebab slug and an anchor

- **WHEN** `createAnalysis({ cwd, name: "Batch 42" })` runs in a fresh directory
- **THEN** the analysis slug is `batch-42`
- **AND** the directory has a marker and an anchors row
- **AND** the analysis has one input referencing the anchor directory

#### Scenario: Duplicate name within an anchor gets a numeric suffix

- **WHEN** a second `createAnalysis({ cwd, name: "Batch 42" })` runs in the same directory
- **THEN** its slug is `batch-42-2`

#### Scenario: Symbol-only name yields a generated handle

- **WHEN** `createAnalysis` is given a name that slugs to empty
- **THEN** the slug is a generated handle (e.g. `analysis-<short>`)

#### Scenario: Output override is stored as an absolute path

- **WHEN** `createAnalysis({ cwd, name, outputOverride })` is given an override
- **THEN** `outputDirectory` is persisted as the absolute form of the override

#### Scenario: Fallback output path is persisted

- **WHEN** the analysis's anchor is not writable so the output resolves to the XDG fallback
- **THEN** that absolute fallback path is persisted onto `outputDirectory`
- **AND** when the anchor is writable, `outputDirectory` stays null (derived)

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
