## ADDED Requirements

### Requirement: File-tool writes produce file-tool provenance records

A successful confined write through the mutate seam SHALL land in the step's
`ProvenanceCollector` as a file-tool record (`recordFileToolWrite`): producer
`{ type: "file_tool", tool: <agent-visible tool name> }`, the content hash
(`sha256:<hex>` computed in-process over the exact bytes written), the byte
size, and an empty input set — agent-authored content is not derived from
input files via execution. A write that does not land (`out_of_scope`,
`out_of_prefix`, `write_failed`) SHALL record nothing.

`recordFileToolWrite` SHALL key the record step-relative, stripping the
`runs/{runId}/{stepId}/` prefix from the artifact path when present (mirroring
`recordCommandExecution`), so file-tool and command records share one keyspace
and the bidirectional last-write-wins unlinking applies to both feeds.

#### Scenario: An agent write_file is attributed to the file tool

- **GIVEN** a sandbox step whose agent writes `output/summary.md` via `write_file`
- **WHEN** the step's artifacts register
- **THEN** the registration input's collector holds a file-tool record for `output/summary.md` with producer `{ type: "file_tool", tool: "write_file" }`, a non-empty `sha256:<hex>` hash, and `inputs: []` — the output is attributed to its file tool, not left to a leaf/command fallback

#### Scenario: edit_file records under its own tool name

- **WHEN** the agent rewrites `scripts/de.R` via `edit_file` and the confined write succeeds
- **THEN** the collector's record for `scripts/de.R` carries `tool: "edit_file"`

#### Scenario: A failed write records nothing

- **WHEN** a `write_file` resolves `out_of_prefix`, or its sandbox write exec exits non-zero
- **THEN** the collector holds no file-tool record for that path

#### Scenario: A later command overwrite supersedes the file-tool record

- **GIVEN** the agent wrote `output/x.csv` via `write_file` and a later exec's frame observed a write to the same path
- **WHEN** registration reads the collector
- **THEN** the path resolves to the command record and the file-tool record is gone

#### Scenario: A file-tool write supersedes an earlier command record

- **GIVEN** an exec's frame observed a write to `output/x.csv` and the agent then rewrote it via `write_file`
- **WHEN** registration reads the collector
- **THEN** the path resolves to the file-tool record with `inputs: []`

#### Scenario: The mutator's own exec frame stays out of the collector

- **WHEN** the mutate seam performs its sandbox byte-write exec
- **THEN** that exec's provenance frame is not threaded through `feedExecFrame` — the in-process file-tool record is the sole attestation, and no command record naming the write interpreter exists for the path
