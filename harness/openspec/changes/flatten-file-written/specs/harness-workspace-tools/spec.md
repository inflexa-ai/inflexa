# harness-workspace-tools — delta

## MODIFIED Requirements

### Requirement: The mutate seam records file-tool provenance

The `WorkspaceMutator` seam SHALL own write provenance the same way it owns
confinement: `createWorkspaceMutator` SHALL accept the step's
`ProvenanceCollector` as an optional construction-time dependency (mirroring
`createExecuteCommandTool`'s optional collector), and `writeFile` SHALL accept
the invoking tool's agent-visible name (`write_file` / `edit_file`) and the
tool call's `invocationId` alongside
`path` and `content`. On a successful confined write the seam SHALL record the
artifact via `recordFileToolWrite` with hash and size computed in-process from
the written bytes, and with the invocation id of the call; on any non-ok
outcome it SHALL record nothing. When no
collector was supplied, the write SHALL proceed unchanged and record nothing.
`ToolContext` SHALL NOT carry the collector.

#### Scenario: write_file passes its tool name through the chokepoint

- **WHEN** the model invokes `write_file` and the confined write succeeds
- **THEN** the seam records the artifact under `toolName: "write_file"` with the context's `invocationId` — the tool factory forwards both and never touches the collector itself

#### Scenario: edit_file records through the same seam

- **WHEN** the model invokes `edit_file` and its whole-content write succeeds
- **THEN** the same `mutator.writeFile` chokepoint records the artifact under `toolName: "edit_file"` with the context's `invocationId` — no second recording path exists

#### Scenario: A collector-less mutator writes without recording

- **GIVEN** a mutator constructed without a collector
- **WHEN** a write succeeds
- **THEN** the `WriteFileResult` is unchanged and no provenance record exists

### Requirement: A conversation-agent write records provenance

Each successful conversation-agent write MUST emit one `write-file` session
event through the provenance seam. The event MUST carry:

- the analysis id
- the thread id, when the scope holds one
- the analysis-root-relative path of the landed file
- the SHA-256 hash of the exact bytes that landed, computed in-process
- the size in bytes
- the name of the file tool that did the write
- the `invocationId` of the tool call

A refused write and a failed write MUST emit nothing. An unbound session emit
records nothing, and the write itself continues unchanged.

#### Scenario: A chat write emits one session event

- **WHEN** `write_file` succeeds on the chat route
- **THEN** the session emit of the seam receives one `write-file` event with
  the path, the hash, the size, the tool `write_file`, and the invocation id

#### Scenario: A refused chat write emits nothing

- **WHEN** a chat write returns `out_of_scope` or `out_of_prefix`
- **THEN** the session emit receives no event
