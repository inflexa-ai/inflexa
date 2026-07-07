# explicit-input-classification Specification

## Purpose

Provenance input classification labels every file a sandbox exec read with how it
relates to the running step: `data` (analysis-level inputs), `artifacts` (the
step's own outputs), `upstream` (another step in the same run), or `prior` (a
file from an earlier run). The classification is explicit — `InputRef` carries
separate `stepId`/`runId` fields rather than overloading a single id — so
downstream lineage and registration can tell a dependency edge from a self-read
without re-parsing paths.

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
result via the `ProvenanceCollector`. It is best-effort and never throws —
provenance must not fail an exec.

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

`feedExecFrame(args: FeedExecFrameArgs)` SHALL translate one sandbox-server exec
provenance frame into the step's `ProvenanceCollector`: for each read in the
frame it SHALL strip the `/{resourceId}/` mount prefix, classify the
analysis-relative path with
`classifyReadPath(rel, collector.stepId, collector.runId, collector.dependsOn)`,
and record it via `collector.trackInputAccess(mountRoot, rel, null, context)`. It
SHALL be best-effort: a disabled or absent frame records the command with no
inputs and no writes, and it SHALL NOT throw.

#### Scenario: Frame read classified from collector context

- **GIVEN** a collector for step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-002/qc/output/qc.csv`
- **THEN** `trackInputAccess` is called with context `{ source: "upstream", stepId: "qc", runId: "run-002" }`

#### Scenario: Disabled frame records the command with no inputs

- **WHEN** `feedExecFrame` is called with a `provenance` frame marked `disabled`
- **THEN** it records the command execution with no inputs and no writes, and does not throw

### Requirement: trackInputAccess uses caller classification, else path fallback

`ProvenanceCollector.trackInputAccess(mountPath, relativePath, hash, context?)` SHALL
use a provided `InputClassificationContext` directly; when none is provided it
SHALL fall back to `classifyReadPath` over its own `stepId`/`runId`/`dependsOn`.
Re-reading the same `mountPath:relativePath` SHALL return the already-tracked ref.

#### Scenario: Caller provides upstream classification

- **WHEN** `trackInputAccess(mountPath, relativePath, null, { source: "upstream", stepId: "qc", runId: "run-002" })` is called
- **THEN** the resulting InputRef has `source: "upstream"`, `stepId: "qc"`, `runId: "run-002"` and no path parsing occurs

#### Scenario: No context falls back to path classification

- **WHEN** `trackInputAccess(mountPath, relativePath, null)` is called without a context
- **THEN** the collector classifies the read via `classifyReadPath` using its own `stepId`/`runId`/`dependsOn`

### Requirement: classifyReadPath resolves five classification branches by prefix

`classifyReadPath(relativePath, ownStepId, ownRunId, dependsOn?)` SHALL resolve in
order:

1. path under `data/` or `dataprofile/` → `{ source: "data" }`
2. path under `runs/{ownRunId}/{ownStepId}/` → `{ source: "artifacts", stepId: ownStepId, runId: ownRunId }`
3. path under `runs/{ownRunId}/{depStepId}/` for a `depStepId` in `dependsOn` → `{ source: "upstream", stepId: depStepId, runId: ownRunId }`
4. any other path under `runs/{ownRunId}/` → a same-run sibling: extract the step id from the path → `{ source: "upstream", stepId, runId: ownRunId }`
5. any other path under `runs/` → a prior run: extract the run and step ids from the path → `{ source: "prior", stepId, runId }`

Anything else SHALL classify as `{ source: "data" }`. Branch 4 exists because
`dependsOn` drives only topo-sort ordering, not read authorization: a read of a
same-run step outside `dependsOn` is still a valid upstream input.

#### Scenario: Own-artifact read classified as artifacts

- **GIVEN** step `de` in run `run-002`
- **WHEN** classifying `runs/run-002/de/output/results.csv`
- **THEN** the result is `{ source: "artifacts", stepId: "de", runId: "run-002" }`

#### Scenario: dependsOn read classified as upstream

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** classifying `runs/run-002/qc/output/qc.csv`
- **THEN** the result is `{ source: "upstream", stepId: "qc", runId: "run-002" }`

#### Scenario: Same-run sibling outside dependsOn classified as upstream

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]`
- **WHEN** classifying `runs/run-002/norm/output/norm.csv` where `norm` is not in `dependsOn`
- **THEN** the result is `{ source: "upstream", stepId: "norm", runId: "run-002" }`

#### Scenario: Prior-run read classified via path extraction

- **GIVEN** step `de` in run `run-002`
- **WHEN** classifying `runs/run-001/de/output/prior.csv`
- **THEN** the result is `{ source: "prior", stepId: "de", runId: "run-001" }`

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
