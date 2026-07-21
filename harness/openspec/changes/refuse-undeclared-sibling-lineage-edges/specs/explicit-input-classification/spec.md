## MODIFIED Requirements

### Requirement: classifyReadPath resolves five classification branches by prefix

`classifyReadPath(relativePath, ownStepId, ownRunId, dependsOn?)` SHALL return a discriminated outcome:
either an **admissible** classification carrying an `InputClassificationContext`, or an explicit
**not-admissible** outcome carrying the producing step's scraped `runId`/`stepId` for diagnostics.

It SHALL resolve in order:

1. path under `data/` or `dataprofile/` → admissible `{ source: "data" }`
2. path under `runs/{ownRunId}/{ownStepId}/` → admissible `{ source: "artifacts", stepId: ownStepId, runId: ownRunId }`
3. path under `runs/{ownRunId}/{depStepId}/` for a `depStepId` in `dependsOn` → admissible `{ source: "upstream", stepId: depStepId, runId: ownRunId }`
4. any other path under `runs/{ownRunId}/` → a same-run sibling this step did not declare → **not admissible**, carrying the step id extracted from the path and `ownRunId`
5. any other path under `runs/` → a prior run: extract the run and step ids from the path → admissible `{ source: "prior", stepId, runId }`

Anything else SHALL classify as admissible `{ source: "data" }`.

Branch 4 refuses because an undeclared sibling has no ordering guarantee relative to this step. Its
directory is mounted read-write in its own container and may be mid-write, or hold a scratch file that is
deleted before this step reconciles, so nothing observed there is a stable artifact this step can be said
to have consumed. Declaration is the available proof of stability: the scheduler admits a step only when
every `depends_on` entry has completed, and a completed step never writes into its tree again. The step id
extracted in branch 4 SHALL be used only to attribute the refusal in diagnostics — it feeds no
classification.

An absent or empty `dependsOn` SHALL therefore refuse every same-run sibling read. Absence of the
declaration is not evidence of stability, and admitting on absence is how an unstable read becomes an
attested edge.

#### Scenario: Own-artifact read classified as artifacts

- **GIVEN** step `de` in run `run-002`
- **WHEN** classifying `runs/run-002/de/output/results.csv`
- **THEN** the result is admissible with `{ source: "artifacts", stepId: "de", runId: "run-002" }`

#### Scenario: dependsOn read classified as upstream

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** classifying `runs/run-002/qc/output/qc.csv`
- **THEN** the result is admissible with `{ source: "upstream", stepId: "qc", runId: "run-002" }`

#### Scenario: Same-run sibling outside dependsOn is not admissible

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** classifying `runs/run-002/norm/output/norm.csv` where `norm` is not in `dependsOn`
- **THEN** the result is not admissible, and no `upstream` classification is produced

#### Scenario: Refusal carries the producing step it names

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** classifying `runs/run-002/norm/output/norm.csv`
- **THEN** the not-admissible outcome carries `refStepId: "norm"` and `refRunId: "run-002"`

#### Scenario: Absent dependsOn refuses every same-run sibling

- **GIVEN** step `de` in run `run-002` classified with no `dependsOn` argument
- **WHEN** classifying `runs/run-002/qc/output/qc.csv`
- **THEN** the result is not admissible — absence of the declaration fails closed rather than admitting

#### Scenario: Prior-run read classified via path extraction

- **GIVEN** step `de` in run `run-002`
- **WHEN** classifying `runs/run-001/de/output/prior.csv`
- **THEN** the result is admissible with `{ source: "prior", stepId: "de", runId: "run-001" }`

### Requirement: feedExecFrame classifies each exec read from structured step context

`feedExecFrame(args: FeedExecFrameArgs)` SHALL translate one sandbox-server exec provenance frame into the
step's `ProvenanceCollector`: for each read in the frame it SHALL strip the `/{resourceId}/` mount prefix
and classify the analysis-relative path with
`classifyReadPath(rel, collector.stepId, collector.runId, collector.dependsOn)`.

It SHALL record only **admissible** reads, via `collector.trackInputAccess(mountRoot, rel, null, context)`.
A read classified not-admissible SHALL be dropped **before** `trackInputAccess` is called, so the path never
enters the collector and can never become an attestation target.

Every refusal SHALL be logged through the injected `Logger` seam with the read path and the producing step
the refusal names. A silent drop is not permitted: an edge asserted over a step that was still writing is
invisible by nature, so an unrecorded refusal would rebuild the same blind spot one layer down.

It SHALL remain best-effort: a disabled or absent frame records the command with no inputs and no writes, a
frame whose every read is refused still records its command, and it SHALL NOT throw.

#### Scenario: Frame read classified from collector context

- **GIVEN** a collector for step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-002/qc/output/qc.csv`
- **THEN** `trackInputAccess` is called with context `{ source: "upstream", stepId: "qc", runId: "run-002" }`

#### Scenario: Undeclared sibling read is dropped before the collector

- **GIVEN** a collector for step `T2S2` with `dependsOn` not containing `T5S1`
- **WHEN** a frame reports a read of `/{resourceId}/runs/{runId}/T5S1/output/_ct_for_r_BRAF.csv`
- **THEN** `trackInputAccess` is not called for that path, no `InputRef` is tracked, and the refusal is logged with the path and `T5S1`

#### Scenario: Command is still recorded when every read is refused

- **GIVEN** a frame whose reads are all undeclared same-run siblings
- **WHEN** `feedExecFrame` runs
- **THEN** `recordCommandExecution` is still called for that exec, with an empty input set, and nothing throws

#### Scenario: Disabled frame records the command with no inputs

- **WHEN** `feedExecFrame` is called with a `provenance` frame marked `disabled`
- **THEN** it records the command execution with no inputs and no writes, and does not throw

### Requirement: trackInputAccess uses caller classification, else path fallback

`ProvenanceCollector.trackInputAccess(mountPath, relativePath, hash, context?)` SHALL use a provided
`InputClassificationContext` directly. When none is provided it SHALL fall back to `classifyReadPath` over
its own `stepId`/`runId`/`dependsOn`, and SHALL track nothing when that fallback classifies the path as
not admissible. Re-reading the same `mountPath:relativePath` SHALL return the already-tracked ref.

#### Scenario: Caller provides upstream classification

- **WHEN** `trackInputAccess(mountPath, relativePath, null, { source: "upstream", stepId: "qc", runId: "run-002" })` is called
- **THEN** the resulting InputRef has `source: "upstream"`, `stepId: "qc"`, `runId: "run-002"` and no path parsing occurs

#### Scenario: No context falls back to path classification

- **WHEN** `trackInputAccess(mountPath, relativePath, null)` is called without a context for an admissible path
- **THEN** the collector classifies the read via `classifyReadPath` using its own `stepId`/`runId`/`dependsOn` and tracks the ref

#### Scenario: No context and an inadmissible path tracks nothing

- **GIVEN** a collector for step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** `trackInputAccess(mountPath, "runs/run-002/norm/output/norm.csv", null)` is called without a context
- **THEN** no `InputRef` is tracked and the tracked-input set is unchanged
