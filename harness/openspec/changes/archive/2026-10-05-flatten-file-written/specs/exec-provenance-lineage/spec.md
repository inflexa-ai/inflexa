# exec-provenance-lineage — delta

## MODIFIED Requirements

### Requirement: File-tool writes produce file-tool provenance records

A successful confined write through the mutate seam MUST land in the step's
`ProvenanceCollector` as a file-tool record (`recordFileToolWrite`). The record
carries the producer
`{ type: "file_tool", tool: <agent-visible tool name>, invocationId }`,
the content hash (`sha256:<hex>` computed in-process over the exact bytes
written), the byte size, and an empty input set. Agent-authored content is not
derived from input files through execution. The `invocationId` is the loop's
tool-call id. It is replay-stable, and the provenance bridge keys the
deterministic call-activity identifier on it. The record carries no
timestamp. A write that does not land
(`out_of_scope`, `out_of_prefix`, `write_failed`) MUST record nothing.

`recordFileToolWrite` MUST key the record step-relative. It strips the
`runs/{runId}/{stepId}/` prefix from the artifact path when the prefix is
present, the same as `recordCommandExecution`. Thus file-tool and command
records share one keyspace, and the bidirectional last-write-wins unlink
applies to both feeds.

#### Scenario: An agent write_file is attributed to the file tool

- **GIVEN** a sandbox step whose agent writes `output/summary.md` with `write_file`
- **WHEN** the step's artifacts register
- **THEN** the registration input's collector holds a file-tool record for `output/summary.md` with producer `{ type: "file_tool", tool: "write_file", invocationId: <the tool-call id> }`, a non-empty `sha256:<hex>` hash, and `inputs: []`
- **AND** the record attributes the output to its file tool, not to a leaf/command fallback

#### Scenario: edit_file records under its own tool name

- **WHEN** the agent rewrites `scripts/de.R` with `edit_file` and the confined write succeeds
- **THEN** the collector's record for `scripts/de.R` carries `tool: "edit_file"` and the invocation id of the call

#### Scenario: A failed write records nothing

- **WHEN** a `write_file` resolves `out_of_prefix`, or its host write fails
- **THEN** the collector holds no file-tool record for that path

#### Scenario: A later command overwrite supersedes the file-tool record

- **GIVEN** the agent wrote `output/x.csv` with `write_file` and a later exec's frame observed a write to the same path
- **WHEN** registration reads the collector
- **THEN** the path resolves to the command record and the file-tool record is gone

#### Scenario: A file-tool write supersedes an earlier command record

- **GIVEN** an exec's frame observed a write to `output/x.csv` and the agent then rewrote it with `write_file`
- **WHEN** registration reads the collector
- **THEN** the path resolves to the file-tool record with `inputs: []`

#### Scenario: A file-tool write produces no exec frame

- **WHEN** the mutate seam writes the bytes with the host filesystem
- **THEN** no exec frame exists for the write, no `feedExecFrame` call occurs, and the in-process file-tool record is the sole attestation
