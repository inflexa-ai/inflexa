# harness-workspace-tools Specification

## Purpose

Define the harness Workspace surfaces — the sandbox-independent **read surface**
(`read_file`, `grep`, semantic `search`) and the sandbox-gated **mutate surface**
(`write_file`, `edit_file`, `execute_command`). Both surfaces resolve paths
through one canonical resolver so a file written by a sandbox step is read back
by `read_file` / `grep` at the identical path.

The resolver implements a **frame-aware path model**: earlier the layer exposed
three disagreeing relative bases (read against the analysis root, write
confinement against the step directory, exec with no default `cwd`), so
`write_file("output/x.csv")` could never succeed and scripts silently wrote into
a discarded `/workspace`. The model collapses this to one rule, parameterised by
the agent's writable **working directory** (a step → `runs/{runId}/{stepId}`; the
data profiler → its profile directory; the conversation agent → the analysis
root, read-only):

- **Relative paths are frame-local** — they resolve against the working
  directory. The same string names the same byte in `read_file`, `write_file`,
  `edit_file`, `execute_command`, and the scripts the agent runs.
- **Absolute `/{resourceId}/...` paths are canonical and frame-independent** —
  they ignore the working directory and resolve against the analysis root in
  every frame. Absolute is the interchange format: any path crossing an agent or
  frame boundary (sub-agent argument, working-memory entry, plan reference) is
  absolute.
- **Reads roam, writes are confined.** Reads resolve anywhere in the analysis
  tree (read-only outside the working directory); a write outside the working
  directory comes back `out_of_prefix`, an out-of-tree or foreign-analysis path
  `out_of_scope`. Both are data variants — never a throw.

The read surface is built on a `WorkspaceFilesystem` seam injected as a
construction-time dependency; the mutate surface is unified behind a
`WorkspaceMutator` seam that owns resolve-and-confine (`resolveForWrite`) +
sandbox byte-write + provenance, so confinement is enforced in one place rather
than re-implemented per tool. The five reserved artifact-subdir names are
rejected as step ids at plan validation so a step directory can never collide
with the artifact convention.

## Requirements

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

### Requirement: read_file tool reads workspace files with bounded output


The harness SHALL expose a `read_file` tool over the workspace read seam. Its
input SHALL be a workspace path (relative to the working directory, or absolute
`/{resourceId}/...`). It SHALL return file content as data. A missing path SHALL
be a `not_found` data variant and an out-of-tree path an `out_of_scope` data
variant — not a throw. The result payload SHALL be bounded by a maximum byte
count (default 256 KiB); a read that exceeds the bound SHALL return a `truncated`
data variant carrying the partial content and the total size.

Only unexpected failures (genuine I/O error, presigned fetch throw) SHALL throw,
so the harness loop's error contract can wrap them as `is_error` results.

#### Scenario: A present file is read back as data

- **GIVEN** a workspace file that exists
- **WHEN** the model invokes `read_file` with that path
- **THEN** the tool result contains the content as an `ok` data variant and is
  not `is_error`

#### Scenario: A missing file is reported as a not-found data variant

- **GIVEN** a path that does not exist
- **WHEN** the model invokes `read_file` with that path
- **THEN** the tool result is a `not_found` data variant and `execute` does not
  throw

#### Scenario: An oversize file returns a truncated variant

- **GIVEN** a workspace file whose size exceeds the `read_file` byte bound
- **WHEN** the model invokes `read_file` with that path
- **THEN** the tool result is a `truncated` data variant carrying the first N
  bytes and the total size

### Requirement: read_file supports head and tail line windows for bio files


The harness `read_file` tool SHALL accept optional `headLines` and `tailLines`
parameters. `headLines: N` returns the first N lines; `tailLines: N` returns the
last N complete lines. The byte cap remains in force — when it binds before the
line cap the result is a `truncated` data variant. The two parameters SHALL be
mutually exclusive; setting both SHALL return an `invalid_input` data variant and
perform no I/O. The implementation SHALL stop reading as soon as the requested
window is satisfied — a 100-line window from a multi-gigabyte file SHALL NOT page
the whole file into memory.

#### Scenario: headLines returns the first N lines of a multi-line file

- **GIVEN** a workspace file with 100 lines
- **WHEN** the model invokes `read_file` with `headLines: 5`
- **THEN** the tool result content contains exactly the first 5 lines, and `mode`
  is `head`

#### Scenario: tailLines returns the last N complete lines

- **GIVEN** a workspace file with 100 lines
- **WHEN** the model invokes `read_file` with `tailLines: 3`
- **THEN** the tool result content contains exactly the last 3 lines, and `mode`
  is `tail`

#### Scenario: headLines is RAM-bounded for huge files

- **GIVEN** a 10,000-line workspace file far larger than the byte cap
- **WHEN** the model invokes `read_file` with `headLines: 5`
- **THEN** the tool returns the first 5 lines and the underlying read stops
  streaming after those lines

#### Scenario: headLines and tailLines together is invalid_input

- **WHEN** the model invokes `read_file` with both `headLines` and `tailLines`
  set
- **THEN** the tool result is an `invalid_input` data variant and no read is
  performed

### Requirement: The read seam accepts an optional embedder-supplied presigned fallback


The `WorkspaceFilesystem` read seam SHALL accept an optional `PresignedFallback`
whose `fetch(...)` returns a `Buffer` or `null`. When a file is absent on the
host session directory and a fallback is configured, the seam SHALL attempt it; a
`null` return SHALL surface as `not_found`. The OSS build omits the fallback —
inputs are materialized locally by the embedder (see the data-profile-init spec) — so a not-materialized
read returns `not_found`. Any content-length / RAM ceiling on the presigned
download is the **managed embedder's realization** of the fallback, not a behavior
the OSS seam ships or guarantees.

#### Scenario: OSS build with no fallback returns not_found

- **GIVEN** a `WorkspaceFilesystem` built with no `presignedFallback`
- **WHEN** `readFile` is called for a path not present on the host
- **THEN** it SHALL return `not_found`, performing no remote fetch

#### Scenario: A configured fallback supplies absent content

- **GIVEN** a `WorkspaceFilesystem` built with a `presignedFallback`
- **WHEN** `readFile` is called for a path not present on the host and the
  fallback returns a Buffer
- **THEN** the seam SHALL return that content (subject to the byte cap); a `null`
  return SHALL become `not_found`

### Requirement: grep tool searches workspace files with bounded results


The harness SHALL expose a `grep` tool over the workspace read seam. It SHALL
accept a pattern and a workspace path (file or directory). It SHALL return
matches as data, including the empty-result case as a data variant rather than a
throw. Both the match count and the per-match payload SHALL be bounded; results
exceeding either bound SHALL carry a truncation marker.

#### Scenario: A pattern with matches returns match data

- **GIVEN** a workspace file containing the literal pattern `sample_id`
- **WHEN** the model invokes `grep` with that pattern and the file's path
- **THEN** the tool result is a data variant containing one or more matches and
  is not `is_error`

#### Scenario: A pattern with no matches returns an empty-result variant

- **GIVEN** a workspace file containing no occurrence of the pattern
- **WHEN** the model invokes `grep` with that pattern and the file's path
- **THEN** the tool result is an empty-match data variant and `execute` does not
  throw

### Requirement: Reserved artifact-subdir names are rejected as step ids


Plan validation SHALL reject any step whose id equals one of the reserved
artifact-subdir names — `scripts`, `output`, `figures`, `logs`, `notebooks` —
case-insensitively, because a step directory `runs/{runId}/{stepId}` named after
one of those would collide with the artifact-subdirectory convention an agent
relies on.

#### Scenario: A reserved name fails plan validation

- **GIVEN** a plan with a step whose id is `figures` (or `OUTPUT`)
- **WHEN** the plan is validated
- **THEN** validation SHALL fail with an error naming the reserved-name rule, and
  the plan SHALL NOT execute

### Requirement: execute_command is the single chokepoint for sandbox command execution


The harness SHALL expose an `execute_command` tool as a dependency-bearing factory
`createExecuteCommandTool(deps)` that captures a `SandboxClient`, the live
`SandboxRef`, the step coordinates (`workflowId`, `stepId`), a per-call function-id
minter, and the step deadline. Its `execute` SHALL be the **only** path through
which sandbox commands run; no other tool, agent, or workflow step SHALL POST to
sandbox-server's `/exec` directly, so the durability/idempotency/liveness story
owned by `SandboxClient` (see the harness-sandbox-exec spec) holds uniformly. The
`SandboxClient` SHALL be captured at construction (see the harness-durable-runtime spec), never retrieved from
an ambient context magic key.

The `execute` SHALL derive a stable `execId` of `"${workflowId}:${stepId}:${functionId}"`
so replays hit the DBOS step cache rather than re-submitting, forward intermediate
events via `ctx.emit` for tool-activity streaming, and return the bounded
`ExecResult` as a data variant. It SHALL default `cwd` to the agent's in-sandbox
working directory (a relative `cwd` resolves against it, an absolute
`/{resourceId}/...` `cwd` is used as-is), making relative paths in scripts agree
with relative paths in the file tools. Only unexpected failures
SHALL throw.

#### Scenario: ToolContext does not carry the SandboxClient

- **GIVEN** the harness `ToolContext` type
- **WHEN** an `execute_command` tool's `execute` is typed against it
- **THEN** the `SandboxClient` is not reachable through `ToolContext` — it is
  captured by the factory closure

#### Scenario: execId is derived deterministically

- **GIVEN** a workflow context with `workflowId="wf1"`, `stepId="step1"`, and a
  function identifier `"fn1"`
- **WHEN** `execute_command` runs
- **THEN** the `execId` SHALL equal `"wf1:step1:fn1"` and SHALL be identical on
  replay so DBOS returns the cached step output

#### Scenario: cwd defaults to the working directory

- **GIVEN** an `execute_command` call that omits `cwd`
- **WHEN** the command runs
- **THEN** it SHALL run in the agent's in-sandbox working directory, so a
  script's relative paths match the file tools' relative paths

#### Scenario: No other tool spawns sandbox work

- **GIVEN** the harness tool registry
- **WHEN** the registry is enumerated
- **THEN** `execute_command` SHALL be the only tool whose factory takes a
  `SandboxClient` dependency, and no other registered tool SHALL POST to
  sandbox-server's `/exec`

### Requirement: execute_command result is bounded with a truncation marker


The `execute_command` result payload SHALL be bounded by a maximum byte count on
each of `stdout` and `stderr` so a chatty command cannot blow the loop's context.
When either stream exceeds the cap the returned data variant SHALL carry a
truncation marker indicating which stream was truncated and the original total
length. Exit code, duration, and any synthetic-failure discriminant SHALL pass
through unchanged regardless of truncation.

#### Scenario: Oversize stdout is truncated with a marker

- **GIVEN** an `ExecResult` whose `stdout` exceeds the per-stream cap
- **WHEN** `execute_command` returns the result
- **THEN** the returned `stdout` SHALL be capped and the result SHALL carry a
  stdout truncation marker with the original total length

#### Scenario: Exit code and synthetic-failure pass through truncation

- **GIVEN** an `ExecResult` carrying a synthetic failure with an oversize stderr
- **WHEN** `execute_command` returns the result
- **THEN** the synthetic-failure discriminant SHALL be preserved and `exitCode`,
  `durationMs`, and `timedOut` SHALL be returned unchanged

### Requirement: write_file is sandbox-gated and confined to the working directory


The harness SHALL expose a `write_file` tool as a factory closure
`createWriteFileTool({ mutator })` — a thin adapter over the `WorkspaceMutator`
seam (see the harness-durable-runtime spec). The mutator owns resolve + confine + sandbox
byte-write + provenance; the tool only declares the input schema (a `path` and
UTF-8 `content`) and forwards. The mutator SHALL resolve `path` through
`resolveForWrite` (relative → working directory, absolute `/{resourceId}/...` →
analysis root) and confine the result to the agent's working directory.

A write whose resolved path is in-tree but outside the working directory
(including the read-only `data/` inputs and other runs) SHALL return an
`out_of_prefix` data variant; one that escapes the analysis tree (`..` traversal,
foreign analysis, absolute out-of-tree) SHALL return `out_of_scope`. Neither is a
throw, a silent clamp, or a permissive write — the model sees the rejection and
corrects. Only unexpected sandbox failures SHALL throw.

#### Scenario: A write inside the working directory succeeds

- **GIVEN** a step whose working directory is `runs/{runId}/{stepId}`
- **WHEN** the model invokes `write_file` with `path` `output/result.csv` and
  content
- **THEN** the mutator resolves the path against the working directory, confirms
  it is inside, writes via the sandbox, and returns an `ok` data variant with the
  resolved `/{resourceId}/...` path and `bytesWritten`

#### Scenario: A write outside the working directory is out_of_prefix

- **GIVEN** the same step working directory
- **WHEN** the model invokes `write_file` with `path` `/{resourceId}/data/inputs/x.csv`
  (the read-only inputs tree)
- **THEN** the tool result SHALL be an `out_of_prefix` data variant, no sandbox
  write SHALL be issued, and `execute` SHALL NOT throw

#### Scenario: A traversal escape is out_of_scope

- **GIVEN** the same step working directory
- **WHEN** the model invokes `write_file` with a path that escapes the analysis
  tree (e.g. `../other-analysis/x.csv`)
- **THEN** the tool result SHALL be an `out_of_scope` data variant and no sandbox
  work SHALL be issued

### Requirement: edit_file is sandbox-gated and confined to the working directory


The harness SHALL expose an `edit_file` tool as a factory closure
`createEditFileTool({ mutator, workspaceFilesystem, workingDir })` that composes
the read seam (fetch current content), a search/replace, and
`WorkspaceMutator.writeFile` — the same resolution + confinement contract as
`write_file`, with no path logic of its own. Edit semantics: replace `old_string`
with `new_string`; `old_string` MUST occur in the file, and when `replace_all` is
false (default) it MUST occur exactly once. Expected outcomes
(`file_not_found`, `not_found`, `not_unique`, `out_of_prefix`, `out_of_scope`)
SHALL be data variants — never throws. The post-edit content SHALL be readable by
the read surface at the same path.

#### Scenario: A round-trip through edit_file and the read surface agrees on path

- **GIVEN** a step that edits `output/notes.md` with new content
- **WHEN** the read surface is then called with the same workspace path
- **THEN** it SHALL return the post-edit content, because both surfaces resolve
  the path through the shared resolver

#### Scenario: A non-unique old_string is not_unique

- **GIVEN** an `edit_file` call with `replace_all` false whose `old_string`
  occurs more than once
- **THEN** the tool result SHALL be a `not_unique` data variant carrying the
  occurrence count, and no write SHALL be issued

#### Scenario: An edit outside the working directory is out_of_prefix

- **GIVEN** a step whose working directory is `runs/{runId}/{stepId}`
- **WHEN** the model invokes `edit_file` with a target under `data/inputs/`
- **THEN** the tool result SHALL be an `out_of_prefix` data variant and no
  sandbox mutation SHALL be issued

### Requirement: Mutate and read surfaces share one canonical resolver


The `WorkspaceMutator` seam SHALL import `resolveForWrite` from
`workspace/paths.ts` — the same module whose `resolveWorkspacePath` the read seam
uses. There SHALL be no second path-construction module on the mutate side;
agreement between the read and mutate surfaces is a structural property of sharing
one module, not a per-surface convention. Scope checking (`/{resourceId}/`
confinement, `..` rejection, absolute-out-of-tree rejection) therefore happens in
the resolver; the mutator layers the `out_of_prefix` working-directory check on
top of a resolved, scope-checked path.

#### Scenario: Mutate and read tools share the path module

- **GIVEN** the harness source tree
- **WHEN** the imports of the mutate path are inspected
- **THEN** the `WorkspaceMutator` SHALL import its resolver from the same module
  as the read seam, and no second resolver implementation SHALL exist on the
  mutate side

#### Scenario: A file written by the mutate surface is read back at the identical path

- **GIVEN** a `write_file` call that writes a step output
- **WHEN** the read surface is called with the same workspace path
- **THEN** both surfaces SHALL resolve to the same session-tree location and the
  content written SHALL be returned
