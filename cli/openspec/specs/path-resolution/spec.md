# path-resolution Specification

## Purpose
Classification and resolution of analysis input path references (anchor-relative when under a tracked anchor, absolute otherwise) and resolution/creation of the per-analysis workspace root — always beside the data at `<anchor>/.inflexa/analyses/<slug>/`; an unresolvable or non-writable anchor is an actionable error, never a fallback.
## Requirements

### Requirement: Classify an input path into a reference


The system SHALL provide `classifyInputPath(analysisId, rawPath, cwd)` returning `Result<AnalysisInput, DbError>` in `src/modules/analysis/input.ts`. It SHALL expand a leading `~`, resolve relative paths against `cwd`, determine `isDir` via a filesystem stat, and use `findMarkerUpwards` on the resolved absolute path to decide membership: when a marker is found and the input is genuinely inside the marker directory, store `(anchorId = marker id, path = clean relative path)`; otherwise store `(anchorId = null, path = absolute)`.

#### Scenario: Path inside a marked directory becomes an anchor-relative ref

- **WHEN** `classifyInputPath` is called on a path inside a directory that has a marker
- **THEN** the returned ref has `anchorId` set to the marker id
- **AND** `path` is the clean relative path from the marker directory (no `..` escape)

#### Scenario: Path outside any marker becomes an absolute ref

- **WHEN** `classifyInputPath` is called on a path with no marker among its ancestors
- **THEN** the returned ref has `anchorId = null` and `path` is the absolute path

#### Scenario: Path escaping the marker dir is stored absolute

- **WHEN** the relative path from the marker directory would start with `..`
- **THEN** the input is stored as `anchorId = null` with an absolute `path`

#### Scenario: Non-existent path is surfaced, not defaulted

- **WHEN** the resolved input path does not exist
- **THEN** `classifyInputPath` returns an `err` (it does not silently default `isDir`)

#### Scenario: isDir reflects the filesystem

- **WHEN** the input path is an existing directory
- **THEN** `isDir` is `true`; when it is an existing file, `isDir` is `false`

### Requirement: Resolve an input reference to an absolute path


The system SHALL provide `resolveInputPath(input)` returning `Result<string | null, DbError>`. When `anchorId` is null it SHALL return the stored absolute `path`; when set it SHALL return `join(resolvedAnchorPath, path)`, or `null` when the anchor cannot be resolved.

#### Scenario: Absolute ref resolves to itself

- **WHEN** `resolveInputPath` is called with `anchorId = null`
- **THEN** it returns the stored absolute `path`

#### Scenario: Anchor-relative ref resolves against the live anchor path

- **WHEN** `resolveInputPath` is called with an `anchorId` whose anchor resolves to a path
- **THEN** it returns `join(anchorPath, input.path)`

#### Scenario: Unresolvable anchor yields null

- **WHEN** the input's anchor cannot be resolved to a live path
- **THEN** `resolveInputPath` returns `null`

### Requirement: Resolve the analysis output directory


The system SHALL provide `resolveOutputDir(analysis)` returning `Result<string, WorkspaceError>` (the `DbError` union widened by an actionable `workspace_unavailable` variant carrying the user-facing message) in `src/modules/analysis/output.ts` with exactly one rule: resolve the analysis's anchor to its live path and return `join(anchorPath, ".inflexa", "analyses", slug)` — the analysis **workspace root**, under which staged inputs (`data/`), run artifacts (`runs/`), reports/previews, and provenance exports all live. When the anchor cannot be resolved, or its folder is not writable, resolution SHALL return an err carrying an actionable message (which folder, why it failed, what the user can do) — there is no fallback and no override. It SHALL NOT create the directory and SHALL NOT persist the result: the root is derived live on every resolution so it follows anchor moves.

#### Scenario: Writable anchor places the workspace beside the data

- **WHEN** the analysis's anchor resolves to a writable path
- **THEN** `resolveOutputDir` returns `join(anchorPath, ".inflexa", "analyses", slug)`

#### Scenario: Non-writable anchor is an actionable error

- **WHEN** the anchor resolves but its folder is not writable
- **THEN** `resolveOutputDir` returns an err whose message names the folder and states that the analysis's workspace cannot be written there

#### Scenario: Unresolvable anchor is an actionable error

- **WHEN** the analysis's anchor cannot be resolved to a live path
- **THEN** `resolveOutputDir` returns an err (never a redirect to another location)

#### Scenario: Resolution follows an anchor move

- **GIVEN** an analysis whose anchor folder is moved (marker intact) between two commands
- **WHEN** `resolveOutputDir` runs after the move is reconciled
- **THEN** it returns the workspace root under the anchor's new path — nothing stale was persisted

### Requirement: Create the analysis output directory


The system SHALL provide `ensureOutputDir(analysis)` returning `Result<string, WorkspaceError>` that resolves the workspace root and creates it recursively (idempotently), returning the absolute path. It SHALL write only to the workspace root location, never to source data, and SHALL propagate resolution errors (non-writable/unresolvable anchor) unchanged.

#### Scenario: Output directory created idempotently

- **WHEN** `ensureOutputDir(analysis)` is called
- **THEN** the resolved directory exists afterward and calling it again succeeds without error

#### Scenario: Resolution failure propagates

- **WHEN** the workspace root cannot be resolved
- **THEN** `ensureOutputDir` returns that err and creates nothing
