## ADDED Requirements

### Requirement: The mutate seam records file-tool provenance

The `WorkspaceMutator` seam SHALL own write provenance the same way it owns
confinement: `createWorkspaceMutator` SHALL accept the step's
`ProvenanceCollector` as an optional construction-time dependency (mirroring
`createExecuteCommandTool`'s optional collector), and `writeFile` SHALL accept
the invoking tool's agent-visible name (`write_file` / `edit_file`) alongside
`path` and `content`. On a successful confined write the seam SHALL record the
artifact via `recordFileToolWrite` with hash and size computed in-process from
the written bytes; on any non-ok outcome it SHALL record nothing. When no
collector was supplied, the write SHALL proceed unchanged and record nothing.
`ToolContext` SHALL NOT carry the collector.

#### Scenario: write_file passes its tool name through the chokepoint

- **WHEN** the model invokes `write_file` and the confined write succeeds
- **THEN** the seam records the artifact under `toolName: "write_file"` — the tool factory forwards its name and never touches the collector itself

#### Scenario: edit_file records through the same seam

- **WHEN** the model invokes `edit_file` and its whole-content write succeeds
- **THEN** the same `mutator.writeFile` chokepoint records the artifact under `toolName: "edit_file"` — no second recording path exists

#### Scenario: A collector-less mutator writes without recording

- **GIVEN** a mutator constructed without a collector
- **WHEN** a write succeeds
- **THEN** the `WriteFileResult` is unchanged and no provenance record exists
