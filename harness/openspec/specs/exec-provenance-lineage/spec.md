# exec-provenance-lineage Specification

## Purpose

Define how runtime-observed file lineage flows from a sandbox `execute_command`
into a step's artifact registration. Each sandbox step owns exactly one
step-scoped `ProvenanceCollector` (`src/provenance/collector.ts`); every exec
contributes a lineage record (which inputs the command read, which script ran),
and at step teardown the populated collector is handed to registration so the
injected `ArtifactRegistry` sees real input/script edges instead of empty ones.

Lineage is content-attested (see the artifact-manifest spec). The
sandbox provenance frame is path-only: it names the files a
command read and wrote but never carries their bytes, so input refs arrive with
empty hashes. `reconcileManifestWithDisk` fills those hashes from disk just
before registration — safe because a tracked input's producer has finished
writing: classification admits a same-run sibling edge only when that sibling
was a declared dependency, which the scheduler guarantees completed before this
step started, and a completed step never writes into its tree again. The
read-only mount does NOT establish this: it bounds what *this* step writes,
while every other step has its own directory mounted read-write over the same
host inodes. An input that cannot be hashed is dropped from lineage rather than
registered hashless (see the artifact-manifest spec for the reconcile rules).

This is the OSS view of the seam. The OSS build exposes the `ArtifactRegistry`
interface with `createNoopArtifactRegistry` as its local default; the live
realization is the embedder's (e.g. the cli's bus adapter feeding a signed
provenance ledger). The seam result is a flat per-path outcome and carries no
managed signing vocabulary. The structured
signing-method payload and any synthesized empty-input collector are a managed
adapter's concern and are not part of OSS core.
## Requirements
### Requirement: Each exec frame is threaded into the step-scoped collector

The sandbox-step body SHALL construct one `ProvenanceCollector` per step, seeded with the step's `stepId`,
`runId`, and `dependsOn`. The `dependsOn` seeding is load-bearing, not informational: classification admits
a same-run sibling edge only on declaration, so a collector seeded without it refuses every same-run read
including legitimate declared dependencies.

`dependsOn` SHALL reach the step body through its durable workflow input. The field SHALL be optional, and
its absence SHALL be treated as an empty declaration list — a workflow recovered under an input shape that
predates the field under-captures every same-run cross-step edge, declared dependencies included, rather
than admitting unstable ones.

The parent SHALL project the field from its keyed plan snapshot (`planStepById`) when building each child's
input, and SHALL throw when the step is absent from it rather than defaulting to an empty list. An empty
list is indistinguishable from a step that genuinely declared nothing, so a silent default would delete
every same-run edge the step was entitled to while leaving no record that it did.

After each `execute_command` resolves its `ExecResult`, the workspace `execute_command` tool SHALL feed that
result's `provenance` frame into the collector via `feedExecFrame` (`src/provenance/exec-frame.ts`).
`feedExecFrame` SHALL strip the `/{resourceId}/` mount prefix from each frame path — collapsing separators
doubled at the boundary so an in-mount name lands on its canonical relative form — classify every read via
`classifyReadPath(relativePath, stepId, runId, dependsOn)`, call `trackInputAccess` for each read that
classification admits, and call `recordCommandExecution` once per exec with that exec's own admitted reads
scoped to its outputs. A read that classification refuses SHALL be dropped and SHALL NOT be tracked. The
refusal SHALL be logged once per distinct path per step: a refusal reports one fact — a lineage edge that
will not exist — and that fact does not change when the same file is read again, while reads dedup within a
frame but not across the many execs a step issues, so an undeduped narration is a steady stream that trains
a reader to filter away the signal. A frame path that does not lie under the mount SHALL ride onto its `InputRef` verbatim, never with
the mount root prepended: reconcile drops both a foreign path and a missing in-tree one, but only the
verbatim name says which of the two happened, and the drop record is the only account a reader gets of a
hook-filter leak. Read hashes SHALL be left unset at track time and filled from disk by
`reconcileManifestWithDisk` before registration. When the frame is absent or `disabled`, `feedExecFrame`
SHALL record the command with no inputs and no writes rather than throw. A `disabled` frame SHALL
additionally be logged: it means the sandbox tracker never started, so the record is empty rather than
complete, and nothing downstream distinguishes the two. Left unlogged, a total capture failure is
indistinguishable from a command that touched no files.

#### Scenario: Command reading an input and writing an output produces a lineage edge

- **GIVEN** an `execute_command` whose argv is `["python3", "scripts/tmm.py"]` and whose `ExecResult.provenance` reads `/{rid}/data/inputs/Lab/counts.csv` and writes `/{rid}/runs/{run}/{step}/output/tmm.csv`
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** `getRecords()` contains a record for `output/tmm.csv` with `producer.type: "command"`, an inferred `scriptPath: "scripts/tmm.py"`, and an input with `source: "data"` for `data/inputs/Lab/counts.csv`

#### Scenario: Upstream read is classified by step metadata

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]` and an exec whose frame reads `/{rid}/runs/run-002/qc/output/qc.csv`
- **WHEN** the read is classified and tracked
- **THEN** the resulting `InputRef` has `source: "upstream"`, `stepId: "qc"`, `runId: "run-002"`

#### Scenario: The collector is seeded with the step's declared dependencies

- **GIVEN** a step whose durable workflow input declares `dependsOn: ["qc"]`
- **WHEN** the sandbox-step body constructs its `ProvenanceCollector`
- **THEN** the collector's `dependsOn` is `["qc"]`, and a frame read of `runs/{runId}/qc/output/qc.csv` produces an `upstream` edge

#### Scenario: A workflow input without dependsOn fails closed

- **GIVEN** a workflow recovered under an input shape that carries no `dependsOn`
- **WHEN** an exec frame reports a read of any same-run sibling's directory
- **THEN** the collector treats the declaration list as empty, the read is refused, and no edge is registered

#### Scenario: A concurrent sibling's scratch file never becomes an attestation target

- **GIVEN** step `T2S2`, whose `dependsOn` does not contain `T5S1`, and an exec frame reporting a read of `/{rid}/runs/{runId}/T5S1/output/_ct_for_r_BRAF.csv`
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** no `InputRef` is tracked for that path, so `reconcileManifestWithDisk` has nothing to attest and the step's lineage never asserted an edge over a sibling that was still writing

#### Scenario: A read outside the mount keeps its own name

- **GIVEN** an exec whose frame reports a read of `/etc/passwd` — naming nothing under the mount, a path the hooks should have filtered
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** the tracked `InputRef` carries `path: "/etc/passwd"` verbatim, and `reconcileManifestWithDisk` later drops it at the container-prefix bound, naming that bound rather than reporting a missing in-tree file

#### Scenario: Missing or disabled frame degrades to no inputs

- **GIVEN** an `ExecResult` whose `provenance` is absent or has `disabled: true`
- **WHEN** the tool feeds it via `feedExecFrame`
- **THEN** the command is recorded with an empty `inputs` array and no error is thrown

#### Scenario: A disabled frame is reported, not silently emptied

- **GIVEN** an `ExecResult` whose `provenance` has `disabled: true`
- **WHEN** the tool feeds it via `feedExecFrame`
- **THEN** a warning naming the command SHALL be logged, so a total capture failure is
  distinguishable from a command that genuinely touched no files

### Requirement: Post-step registration consumes runtime-derived lineage

`reconcileAndRegisterStepArtifacts` SHALL pass the step's populated
`ProvenanceCollector` to `registerStepArtifacts` so the `ArtifactRegistry.register`
input carries the real observed input/script edges. The harness SHALL NOT
register step outputs with an unconditionally empty input set, and SHALL NOT
construct a synthesized empty-input collector. Absence of observed lineage SHALL
never block registration: an output with no tracked inputs (an agent `write_file`,
or a frame-less exec) SHALL still register through the seam.

#### Scenario: Output with observed inputs registers with its lineage

- **GIVEN** a step collector holding a command record for `output/tmm.csv` with one `source: "data"` input
- **WHEN** `reconcileAndRegisterStepArtifacts` runs
- **THEN** the `ArtifactRegistry.register` input for that step carries the collector with `output/tmm.csv`'s observed input edge

#### Scenario: Output with no inputs still registers

- **GIVEN** a step that wrote `output/notes.md` via the agent `write_file` tool with no tracked input reads
- **WHEN** registration runs
- **THEN** `output/notes.md` registers successfully and registration of the step's other artifacts is unaffected

#### Scenario: No synthesized empty-input collector exists

- **WHEN** the harness builds the post-step registration deps
- **THEN** no code path constructs a collector that hard-codes empty `inputs` and `getDataInputs()` for every output

### Requirement: Sandbox provenance capture is scoped to the analysis resource mount

`buildMountPlan` SHALL set the container's `PROVENANCE_WATCH_DIRS` to the
analysis resource mount root (`/{resourceId}`), covering both the read-only
`data/` tree and the `runs/` tree, rather than the sandbox-server's `/data`
default. The Go sandbox-server SHALL derive the in-container layer prefixes
(`PROVENANCE_DATA_PREFIXES`) from that watch configuration. Reads and writes
outside the resource mount (system libraries, `/mnt/libs`, interpreter internals)
SHALL fall outside the prefixes and SHALL NOT appear in the frame.

#### Scenario: Input read under the resource mount is captured

- **GIVEN** an analysis mounted at `/{resourceId}` and a sandbox created for one of its steps
- **WHEN** a script reads `/{resourceId}/data/inputs/Lab/counts.csv`
- **THEN** the exec frame's `reads` includes that path

#### Scenario: Library read is not captured

- **GIVEN** the same sandbox
- **WHEN** a script imports a package from `/mnt/libs`
- **THEN** the exec frame's `reads` does NOT include any `/mnt/libs` path

### Requirement: File-tool writes produce file-tool provenance records

A successful confined write through the mutate seam MUST land in the step's
`ProvenanceCollector` as a file-tool record (`recordFileToolWrite`). The record
carries the producer `{ type: "file_tool", tool: <agent-visible tool name> }`,
the content hash (`sha256:<hex>` computed in-process over the exact bytes
written), the byte size, and an empty input set. Agent-authored content is not
derived from input files through execution. A write that does not land
(`out_of_scope`, `out_of_prefix`, `write_failed`) MUST record nothing.

`recordFileToolWrite` MUST key the record step-relative. It strips the
`runs/{runId}/{stepId}/` prefix from the artifact path when the prefix is
present, the same as `recordCommandExecution`. Thus file-tool and command
records share one keyspace, and the bidirectional last-write-wins unlink
applies to both feeds.

#### Scenario: An agent write_file is attributed to the file tool

- **GIVEN** a sandbox step whose agent writes `output/summary.md` with `write_file`
- **WHEN** the step's artifacts register
- **THEN** the registration input's collector holds a file-tool record for `output/summary.md` with producer `{ type: "file_tool", tool: "write_file" }`, a non-empty `sha256:<hex>` hash, and `inputs: []`
- **AND** the record attributes the output to its file tool, not to a leaf/command fallback

#### Scenario: edit_file records under its own tool name

- **WHEN** the agent rewrites `scripts/de.R` with `edit_file` and the confined write succeeds
- **THEN** the collector's record for `scripts/de.R` carries `tool: "edit_file"`

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

