# harness-workspace-tools Delta

## ADDED Requirements

### Requirement: The read seam converts an unresolvable workspace root into an error value

`createWorkspaceFilesystem` SHALL call `resolveWorkspaceRoot` inside its own boundary conversion and return `err(FsError)` — `type: "read_failed"`, `op: "workspace.resolveWorkspaceRoot"`, with the resource id as `path` and the thrown value as `cause` — rather than propagating the exception. It SHALL NOT rely on a caller's incidental `catch` (the agent loop's `dispatchTool` wraps `tool.execute`) to contain it, because the seam's type says the failure is a value.

`resolveWorkspaceRoot` signals an unresolvable resource by throwing (workspace-root-resolution), which is the correct protocol inside a DBOS body. `createWorkspaceFilesystem` is not a DBOS body: `readFile`, `list`, and `stat` are typed `ResultAsync<_, FsError>`, and they are reachable from a live chat turn whose analysis root may have been moved or deleted since the turn began.

#### Scenario: An unresolvable root is an err on every read method

- **GIVEN** a `WorkspaceFilesystem` whose `resolveWorkspaceRoot` throws for the session's resource
- **WHEN** `readFile`, `list`, or `stat` is called
- **THEN** each returns `err(FsError)` with `op: "workspace.resolveWorkspaceRoot"` — no exception escapes

#### Scenario: An unresolvable root is distinguishable from an out-of-scope path

- **GIVEN** a `WorkspaceFilesystem` whose root resolves normally
- **WHEN** `readFile` is called with a path that escapes the analysis tree
- **THEN** it returns `ok({ kind: "out_of_scope" })`, not an err — scope violations remain in-band data, and only resolution failure uses the error channel
