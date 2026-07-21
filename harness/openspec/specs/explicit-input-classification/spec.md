# explicit-input-classification Specification

## Purpose

Provenance input classification decides, for each file a sandbox exec read,
whether the step may assert an input edge for it — and if so, how that file
relates to the running step: `data` (analysis-level inputs), `artifacts` (the
step's own outputs), `upstream` (another step in the same run), or `prior` (a
file from an earlier run). The classification is explicit — `InputRef` carries
separate `stepId`/`runId` fields rather than overloading a single id — so
downstream lineage and registration can tell a dependency edge from a self-read
without re-parsing paths.

Not every observed read earns a label. A read under a same-run sibling the step
never declared is refused outright: that sibling has no ordering guarantee
relative to this step, so nothing observed in its directory is a stable artifact
this step can be said to have consumed. A refusal is a distinct outcome from a
classification, never a fallback label.

Classification is driven from structured step context (the step's own `stepId`
and `runId`, plus its `dependsOn` list) by prefix matching, not path-segment
extraction. The one exception is prior-run reads: a prior-run path matches
neither the step's own ids nor its `dependsOn` prefixes, so no structured
context can classify it, and that single branch falls back to extracting the
run and step ids from the path — documented in-code as the lone path-parsing
case.

The integration point is `feedExecFrame`: it ingests one sandbox-server exec
provenance frame, strips the `/{resourceId}/` mount prefix from each read,
classifies the analysis-relative path with `classifyReadPath`, and records the
admissible results via the `ProvenanceCollector` — a refused read is dropped
and logged before it reaches the collector, so it can never become an
attestation target. It is best-effort and never throws — provenance must not
fail an exec.

## Requirements

### Requirement: InputRef carries explicit source, stepId, and runId

`InputRef` SHALL classify each read with a `source` of
`"data" | "upstream" | "prior" | "artifacts"` and explicit `stepId?`/`runId?`
fields (no overloaded `sourceId`):

- `data` inputs: `stepId` and `runId` SHALL be absent (data inputs are analysis-level, not step-scoped).
- `upstream` inputs: `stepId` SHALL be the producing step's id, `runId` the current run's id.
- `prior` inputs: `stepId` and `runId` SHALL be the prior step's and run's ids.
- `artifacts` inputs: `stepId` and `runId` SHALL be the current step's and run's ids.

#### Scenario: Upstream input carries the producer step and current run

- **WHEN** step `de` in run `run-002` reads `runs/run-002/qc/output/qc.csv` and `qc` is in `dependsOn`
- **THEN** the InputRef has `source: "upstream"`, `stepId: "qc"`, `runId: "run-002"`

#### Scenario: Data input has no step or run

- **WHEN** step `de` reads `data/inputs/Lab/counts.csv`
- **THEN** the InputRef has `source: "data"`, `stepId: undefined`, `runId: undefined`

#### Scenario: Prior-run input carries the prior step and run

- **WHEN** step `de` in run `run-002` reads `runs/run-001/de/output/prior.csv`
- **THEN** the InputRef has `source: "prior"`, `stepId: "de"`, `runId: "run-001"`

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

### Requirement: Prior-run classification is the one documented path-extraction fallback

The prior-run branch SHALL be the only place classification parses path segments,
and SHALL carry an in-code comment stating why the fallback exists: a read under
`runs/{otherRunId}/…` that matches neither the step's own run nor a `dependsOn`
entry carries no step metadata linking it, so the path segments are the only
available source for the `{source: "prior", runId, stepId}` classification. The
comment SHALL describe only code that exists — it SHALL NOT reference
declarations, types, or plumbing absent from the tree.

#### Scenario: Comment exists at the fallback location

- **WHEN** a developer reads the prior-run classification branch
- **THEN** they find a comment stating why path extraction is the only source for prior-run identity, with no references to nonexistent declarations
