# path-resolution Specification

## Purpose
Classification and resolution of analysis input path references (anchor-relative when under a tracked anchor, absolute otherwise) and resolution/creation of the per-analysis output directory — beside the data when writable, XDG fallback otherwise.
## Requirements
### Requirement: Output fallback directory in env

The system SHALL expose `env.outputFallbackDir` resolving to `join(dataDir(), "inf", "analyses")`, defined in `src/lib/env.ts` (the only `process.env` reader), with a matching `envDoc` entry so it renders in `--help`.

#### Scenario: Fallback dir derives from the data home

- **WHEN** `env.outputFallbackDir` is read
- **THEN** it equals `<data home>/inf/analyses`
- **AND** an `envDoc.outputFallbackDir` entry of kind `path` exists for `--help`

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

The system SHALL provide `resolveOutputDir(analysis)` returning `Result<string, DbError>` in `src/modules/analysis/output.ts`, using three cases in order: (1) when `analysis.outputDirectory` is non-null, use it; (2) else when the anchor resolves to a writable path, use `join(anchorPath, ".inf", "analyses", slug)`; (3) otherwise use `join(env.outputFallbackDir, slug)`. It SHALL NOT create the directory or persist the choice.

#### Scenario: Explicit override wins

- **WHEN** `analysis.outputDirectory` is non-null
- **THEN** `resolveOutputDir` returns that path unchanged

#### Scenario: Writable anchor places output beside the data

- **WHEN** `outputDirectory` is null and the anchor resolves to a writable path
- **THEN** `resolveOutputDir` returns `join(anchorPath, ".inf", "analyses", slug)`

#### Scenario: Non-writable or unresolvable anchor uses the fallback

- **WHEN** `outputDirectory` is null and the anchor is not writable or cannot be resolved
- **THEN** `resolveOutputDir` returns `join(env.outputFallbackDir, slug)`

### Requirement: Create the analysis output directory

The system SHALL provide `ensureOutputDir(analysis)` returning `Result<string, DbError>` that resolves the output directory and creates it recursively (idempotently), returning the absolute path. It SHALL write only to the output directory location, never to source data.

#### Scenario: Output directory created idempotently

- **WHEN** `ensureOutputDir(analysis)` is called
- **THEN** the resolved directory exists afterward and calling it again succeeds without error

