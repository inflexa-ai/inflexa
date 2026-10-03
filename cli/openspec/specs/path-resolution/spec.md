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

Resolution SHALL NOT record an anchor sighting (`resolveAnchor(anchorId, { touch: false })`). Deriving a workspace root is not evidence that the user visited the folder, and the harness derives one on every agent file read — a heartbeat here would both misreport folder liveness and put a synchronous database write on the read path.

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

#### Scenario: Resolution leaves the anchor heartbeat alone

- **WHEN** `resolveOutputDir` resolves an analysis's anchor
- **THEN** the anchor's `last_seen` is unchanged

### Requirement: Create the analysis output directory

The system SHALL provide `ensureOutputDir(analysis)` returning `Result<string, WorkspaceError>` that resolves the workspace root and creates it recursively (idempotently), returning the absolute path. It SHALL write only to the workspace root location, never to source data, and SHALL propagate resolution errors (non-writable/unresolvable anchor) unchanged.

#### Scenario: Output directory created idempotently

- **WHEN** `ensureOutputDir(analysis)` is called
- **THEN** the resolved directory exists afterward and calling it again succeeds without error

#### Scenario: Resolution failure propagates

- **WHEN** the workspace root cannot be resolved
- **THEN** `ensureOutputDir` returns that err and creates nothing

### Requirement: Resolve a workspace root by analysis id, memoized

The system SHALL provide `workspaceRootForAnalysisId(analysisId)` returning `Result<string, WorkspaceError>` in `src/modules/analysis/output.ts` — the id-only lookup the harness's `resolveWorkspaceRoot` realization and the artifact resolution of the local server need. An id with no analysis row SHALL be `workspace_unavailable` (an analysis that does not exist has no workspace), never a `DbError`.

The harness calls this once per `read_file`, `grep`, and `stat` the agent issues, and each derivation costs an analysis lookup, an anchor lookup, a marker read, and an `access(2)`. Successful resolutions SHALL therefore be memoized. The memo SHALL be process-local and start empty, so a DBOS-recovered workflow on a fresh process still derives from durable state. The process is the local server: the routes that rename or retire a workspace run in the same process as the harness, thus their invalidation reaches the memo that the harness reads. Failures SHALL NOT be memoized: the user may be fixing the folder between calls. The memo SHALL be invalidated for an analysis by any in-process action that moves or retires its root (rename, disposal), and SHALL additionally expire on a short TTL so an out-of-process anchor move cannot pin a stale root for the session's lifetime.

The system SHALL expose `invalidateWorkspaceRoot(analysisId?)` — clearing one entry, or the whole memo when the id is omitted.

#### Scenario: A resolved root is served from the memo

- **GIVEN** an analysis whose root has been resolved once
- **WHEN** the row is deleted and the root is resolved again within the TTL
- **THEN** the memoized root is returned

#### Scenario: Invalidation forces a re-derivation

- **GIVEN** a memoized root for an analysis
- **WHEN** `invalidateWorkspaceRoot(analysisId)` runs and the root is resolved again
- **THEN** resolution goes back to the database

#### Scenario: A failure is never memoized

- **GIVEN** an analysis whose anchor folder is not writable, and a failed resolution
- **WHEN** the folder is made writable and the root is resolved again
- **THEN** resolution succeeds

### Requirement: Name the workspace retirement location

The system SHALL provide `archivedOutputSubdir(slug)` in `src/modules/analysis/output.ts` returning `.inflexa/analyses_archived/<slug>` — the anchor-relative path a deleted analysis's workspace is moved to when the user keeps its files. It SHALL be a sibling of `.inflexa/analyses/`, never a child of it, so a freed slug can never resolve onto a retired tree. The `.inflexa` directory is already excluded from the input-staging walk, so archived trees are not stageable as inputs.

#### Scenario: The archive is a sibling of the live tree

- **WHEN** `archivedOutputSubdir("trial")` is called
- **THEN** it returns `.inflexa/analyses_archived/trial`, which is not under `.inflexa/analyses/`

### Requirement: A client resolves a path of the user against its own folder

A client of the local server SHALL expand a leading `~` of each path that the user gives, and resolve a relative path against the working folder of the client process, before it sends the path. The local server SHALL accept only an absolute path in a request body where a path of the user goes (an analysis folder, an input to add, an anchor path, an export destination), and SHALL refuse a relative one with 400 `validation_error`. The one exception is an input removal: a relative path there SHALL match only the stored anchor-relative `path` of an input, so an input whose folder is gone stays removable. The server never resolves a path against its own working folder, because that folder is not the folder of the user.

#### Scenario: A relative input resolves in the folder of the command

- **WHEN** `inflexa inputs add data/counts.csv` runs in `/work/study`
- **THEN** the command sends `/work/study/data/counts.csv` to the server

#### Scenario: A home-relative path expands in the client

- **WHEN** `inflexa repair ~/study` runs
- **THEN** the command sends the absolute path of `study` under the home folder of the user

#### Scenario: The server refuses a relative path

- **WHEN** a request to add an input (`POST {A}/inputs`) carries the path `data/counts.csv`
- **THEN** the server answers 400 `validation_error` and changes nothing
