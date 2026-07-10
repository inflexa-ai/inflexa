# path-resolution Delta

## REMOVED Requirements

### Requirement: Output fallback directory in env

**Reason**: The fallback root is deleted by design decision D2 of `unify-analysis-workspace` — a non-writable or unresolvable anchor is an actionable error, never a silent redirect to an XDG directory the user was not looking at. With it die `env.outputFallbackDir` and its `envDoc` entry.
**Migration**: None (unshipped). Analyses whose anchor is not writable cannot be created; existing rows resolving to the fallback have no supported state.

## MODIFIED Requirements

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
