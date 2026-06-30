# exec-provenance-lineage Specification

## Purpose

Define how runtime-observed file lineage flows from a sandbox `execute_command`
into a step's artifact registration. Each sandbox step owns exactly one
step-scoped `ProvenanceCollector` (`src/provenance/collector.ts`); every exec
contributes a lineage record (which inputs the command read, which script ran),
and at step teardown the populated collector is handed to registration so the
injected `ArtifactRegistry` sees real input/script edges instead of empty ones.

Lineage is content-attested and fail-fast (see the artifact-manifest spec). The
sandbox provenance frame is path-only: it names the files a
command read and wrote but never carries their bytes, so input refs arrive with
empty hashes. `reconcileManifestWithDisk` fills those hashes from disk just
before registration (inputs are immutable for the step — the analysis tree is
mounted read-only), and an input that cannot be hashed is terminal rather than
registered hashless (see the artifact-manifest spec for the reconcile rules).

This is the OSS view of the seam. The OSS build exposes only the `ArtifactRegistry`
interface and its `FilesystemArtifactRegistry` realization; the seam result is a
flat per-path outcome and carries no managed signing vocabulary. The structured
signing-method payload and any synthesized empty-input collector are a managed
adapter's concern and are not part of OSS core.

## Requirements

### Requirement: Each exec frame is threaded into the step-scoped collector

The sandbox-step body SHALL construct one `ProvenanceCollector` per step, seeded
with the step's `stepId`, `runId`, and `dependsOn`. After each `execute_command`
resolves its `ExecResult`, the workspace `execute_command` tool SHALL feed that
result's `provenance` frame into the collector via `feedExecFrame`
(`src/provenance/exec-frame.ts`). `feedExecFrame` SHALL strip the
`/{resourceId}/` mount prefix from each frame path, classify every read via
`classifyReadPath(relativePath, stepId, runId, dependsOn)`, call
`trackInputAccess` per read, and call `recordCommandExecution` once per exec with
that exec's own reads scoped to its outputs. Read hashes SHALL be left unset at
track time and filled from disk by `reconcileManifestWithDisk` before
registration. When the frame is absent or `disabled`, `feedExecFrame` SHALL
record the command with no inputs and no writes rather than throw.

#### Scenario: Command reading an input and writing an output produces a lineage edge

- **GIVEN** an `execute_command` whose argv is `["python3", "scripts/tmm.py"]` and whose `ExecResult.provenance` reads `/{rid}/data/inputs/Lab/counts.csv` and writes `/{rid}/runs/{run}/{step}/output/tmm.csv`
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** `getRecords()` contains a record for `output/tmm.csv` with `producer.type: "command"`, an inferred `scriptPath: "scripts/tmm.py"`, and an input with `source: "data"` for `data/inputs/Lab/counts.csv`

#### Scenario: Upstream read is classified by step metadata

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]` and an exec whose frame reads `/{rid}/runs/run-002/qc/output/qc.csv`
- **WHEN** the read is classified and tracked
- **THEN** the resulting `InputRef` has `source: "upstream"`, `stepId: "qc"`, `runId: "run-002"`

#### Scenario: Missing or disabled frame degrades to no inputs

- **GIVEN** an `ExecResult` whose `provenance` is absent or has `disabled: true`
- **WHEN** the tool feeds it via `feedExecFrame`
- **THEN** the command is recorded with an empty `inputs` array and no error is thrown

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
