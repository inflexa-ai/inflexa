## MODIFIED Requirements

### Requirement: Each exec frame is threaded into the step-scoped collector

The sandbox-step body SHALL construct one `ProvenanceCollector` per step, seeded with the step's `stepId`,
`runId`, and `dependsOn`. The `dependsOn` seeding is load-bearing, not informational: classification admits
a same-run sibling edge only on declaration, so a collector seeded without it refuses every same-run read
including legitimate declared dependencies.

`dependsOn` SHALL reach the step body through its durable workflow input. The field SHALL be optional, and
its absence SHALL be treated as an empty declaration list — a workflow recovered under an input shape that
predates the field under-captures same-run sibling edges rather than admitting unstable ones.

After each `execute_command` resolves its `ExecResult`, the workspace `execute_command` tool SHALL feed that
result's `provenance` frame into the collector via `feedExecFrame` (`src/provenance/exec-frame.ts`).
`feedExecFrame` SHALL strip the `/{resourceId}/` mount prefix from each frame path — collapsing separators
doubled at the boundary so an in-mount name lands on its canonical relative form — classify every read via
`classifyReadPath(relativePath, stepId, runId, dependsOn)`, call `trackInputAccess` for each read that
classification admits, and call `recordCommandExecution` once per exec with that exec's own admitted reads
scoped to its outputs. A read that classification refuses SHALL be dropped and logged, and SHALL NOT be
tracked. A frame path that does not lie under the mount SHALL ride onto its `InputRef` verbatim, never with
the mount root prepended: forging an in-tree name for a foreign path would surface at reconcile as phantom
drift (a missing file, which fails the step) instead of the out-of-tree read it is (which reconcile drops
from lineage). Read hashes SHALL be left unset at track time and filled from disk by
`reconcileManifestWithDisk` before registration. When the frame is absent or `disabled`, `feedExecFrame`
SHALL record the command with no inputs and no writes rather than throw.

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
- **THEN** no `InputRef` is tracked for that path, so `reconcileManifestWithDisk` has nothing to attest and the step does not fail with `lineage_attestation` when `T5S1` later deletes the file

#### Scenario: A read outside the mount keeps its own name

- **GIVEN** an exec whose frame reports a read of `/etc/passwd` — naming nothing under the mount, a path the hooks should have filtered
- **WHEN** the tool feeds the frame via `feedExecFrame`
- **THEN** the tracked `InputRef` carries `path: "/etc/passwd"` verbatim, and `reconcileManifestWithDisk` later drops it at the container-prefix bound rather than failing the step

#### Scenario: Missing or disabled frame degrades to no inputs

- **GIVEN** an `ExecResult` whose `provenance` is absent or has `disabled: true`
- **WHEN** the tool feeds it via `feedExecFrame`
- **THEN** the command is recorded with an empty `inputs` array and no error is thrown
