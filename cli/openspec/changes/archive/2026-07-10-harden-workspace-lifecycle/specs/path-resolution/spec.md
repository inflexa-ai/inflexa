# path-resolution Delta

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Resolve a workspace root by analysis id, memoized

The system SHALL provide `workspaceRootForAnalysisId(analysisId)` returning `Result<string, WorkspaceError>` in `src/modules/analysis/output.ts` — the id-only lookup the harness's `resolveWorkspaceRoot` realization and the TUI's card resolver need. An id with no analysis row SHALL be `workspace_unavailable` (an analysis that does not exist has no workspace), never a `DbError`.

The harness calls this once per `read_file`, `grep`, and `stat` the agent issues, and each derivation costs an analysis lookup, an anchor lookup, a marker read, and an `access(2)`. Successful resolutions SHALL therefore be memoized. The memo SHALL be process-local and start empty, so a DBOS-recovered workflow on a fresh process still derives from durable state. Failures SHALL NOT be memoized: the user may be fixing the folder between calls. The memo SHALL be invalidated for an analysis by any in-process action that moves or retires its root (rename, disposal), and SHALL additionally expire on a short TTL so an out-of-process anchor move cannot pin a stale root for the session's lifetime.

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
