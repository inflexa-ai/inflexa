# harness-workspace-tools Delta

## MODIFIED Requirements

### Requirement: Workspace read seam is a construction-time dependency

The harness SHALL expose a workspace filesystem read seam —
`createWorkspaceFilesystem(deps)` returning `{ readFile, list, stat }` over the
analysis workspace tree — injected at the composition root as a construction-time
dependency (see the harness-durable-runtime spec). Its deps SHALL carry the
`resolveWorkspaceRoot` seam (workspace-root-resolution), not a global base path.
It SHALL NOT be retrieved from an ambient context magic
key. A tool that depends on the seam SHALL receive it through a factory closure
(e.g. `createReadFileTool(fs, workingDir?)`) so the dependency is visible in the
factory signature and replaceable with a fake in tests.

Reads SHALL resolve from the resolved workspace root when the file is
materialized, falling back to an optional embedder-supplied presigned fetch when
it is not. The seam SHALL NOT write provenance and SHALL NOT depend on any
sandbox. Relative paths resolve against the caller-supplied `workingDir`
(frame-local); when omitted they resolve against the analysis root, which is the
conversation-agent behaviour.

#### Scenario: A tool factory takes the filesystem as a parameter

- **GIVEN** the `createReadFileTool` factory
- **WHEN** the factory is called at the composition root
- **THEN** it accepts an `fs` parameter typed as the workspace filesystem seam,
  and returns a tool whose `execute` closes over that `fs`

#### Scenario: ToolContext does not carry the filesystem

- **GIVEN** the harness `ToolContext` type
- **WHEN** a workspace read tool's `execute` is typed against it
- **THEN** the filesystem is not reachable through `ToolContext` — it is captured
  by the factory closure

#### Scenario: A materialized file is read from the workspace root

- **GIVEN** an analysis whose input file is materialized on the host
- **WHEN** the seam's `readFile` is called with that path
- **THEN** it returns the file content read from under the analysis's resolved
  workspace root without a remote round-trip

### Requirement: Frame-aware path resolution

Relative paths SHALL resolve against the caller's working directory; absolute
`/{resourceId}/...` paths SHALL resolve against the analysis root regardless of
the working directory. The resolver (`resolveWorkspacePath` in
`workspace/paths.ts`) SHALL return an `out_of_scope` data variant for any input
that escapes the analysis's resolved workspace root — `..` traversal, absolute
paths outside the tree, and `/{otherResourceId}/...` — never a throw. The
container-absolute `/{resourceId}/...` form is unchanged by where the root
lives on the host: it maps onto the root via the shared host↔container formula.

#### Scenario: A relative path is frame-local

- **GIVEN** a step whose working directory is `runs/{runId}/{stepId}`
- **WHEN** a tool resolves the relative path `output/x.csv`
- **THEN** it SHALL resolve to that step's `output/x.csv`, the same file a
  script's `open("output/x.csv")` and a later `read_file("output/x.csv")` name

#### Scenario: An absolute path is frame-independent

- **GIVEN** the same step working directory
- **WHEN** a tool resolves `/{resourceId}/data/inputs/x.csv`
- **THEN** it SHALL resolve against the analysis root, ignoring the working
  directory, so the same absolute path names the same byte in every frame

#### Scenario: A traversal escape is out_of_scope

- **GIVEN** an active analysis `A`
- **WHEN** any caller resolves a path that escapes `/A/` (e.g.
  `/A/../B/secret.txt` or `/etc/passwd`)
- **THEN** the resolver SHALL return `out_of_scope` before any I/O
