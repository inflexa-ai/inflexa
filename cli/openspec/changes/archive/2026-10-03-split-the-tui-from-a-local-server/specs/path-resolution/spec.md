## MODIFIED Requirements

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

## ADDED Requirements

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
