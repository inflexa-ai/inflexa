# explicit-input-classification — delta

## MODIFIED Requirements

### Requirement: classifyReadPath resolves five classification branches by prefix

`classifyReadPath(relativePath, ownStepId, ownRunId, dependsOn?, completedSteps?)` SHALL resolve in
order, where `completedSteps` is the set of `(runId, stepId)` PAIRS — scoped to the
ANALYSIS, not to a single run — whose `cortex_step_executions.status` was observed
`completed` at the moment the reading exec was submitted:

1. path under `data/` or `dataprofile/` → `{ source: "data" }`
2. path under `runs/{ownRunId}/{ownStepId}/` → `{ source: "artifacts", stepId: ownStepId, runId: ownRunId }`
3. path under `runs/{ownRunId}/{depStepId}/` for a `depStepId` in `dependsOn` → `{ source: "upstream", stepId: depStepId, runId: ownRunId }` when `(ownRunId, depStepId)` is in `completedSteps`, otherwise the inadmissible outcome
4. any other path under `runs/{ownRunId}/` → a same-run sibling: extract the step id from the path → `{ source: "upstream", stepId, runId: ownRunId }` when `(ownRunId, stepId)` is in `completedSteps`, otherwise the inadmissible outcome
5. any other path under `runs/` → a prior run: extract the run and step ids from the path → `{ source: "prior", stepId, runId }` when that extracted `(runId, stepId)` pair is in `completedSteps`, otherwise the inadmissible outcome

Anything else SHALL classify as `{ source: "data" }`.

The observation point SHALL be **exec-submit time**, and no wording in this capability
SHALL substitute "started" for "submitted". Submit precedes start, so a step observed
`completed` at submit time was necessarily completed before any read that exec performs.
Reading the snapshot at submit time is therefore deliberately STRICTER than reading it at
start time — it excludes a sibling that completed in the window between submit and start —
and that strictness is intentional: an under-reported edge is a recoverable gap, a
fabricated edge is a corrupt record. It is not an approximation of start-time to be
loosened later.

Every edge to a producing step SHALL be gated by ONE predicate: the edge is admissible if
and only if that step's `cortex_step_executions.status` was `completed` when the reading
exec was submitted — regardless of which run the producing step belongs to. An artifact is
stable because the step that writes it finished, not because its run finished, so a prior
run's completed step qualifies, a prior run's failed step does not, and a concurrent
sibling does not. Branches 3, 4, and 5 therefore differ only in where the `(runId, stepId)`
pair under test comes from — `dependsOn` paired with `ownRunId` for branch 3, the step id
scraped from the path paired with `ownRunId` for branch 4, and both ids scraped from the
path for branch 5 — never in what is asked of it.

`completed` SHALL be the ONLY admissible status: `failed`, `canceled`, `skipped`,
`blocked`, `running`, `queued`, and absent-from-the-set SHALL all yield the inadmissible
outcome, because a step that has not completed never finalized its outputs and so has no
stable artifact that could have been consumed. The gate applies to branch 3 as well as
branch 4 — a declared `dependsOn` sibling that has somehow not completed is still
inadmissible; declaration does not exempt it — and to branch 5 alike, which is therefore
no longer an unconditional classification: it keeps its scraped ids and its `prior` source
only under the gate. Branches 1 and 2 SHALL keep their current behaviour, and branch 3
SHALL keep its current classification for a completed dependency.

Branch 5 SHALL NOT consult the state of the referenced RUN, and this capability SHALL NOT
read `cortex_runs` at all. A run that has finished says nothing about whether every step
inside it finalized its outputs — a FAILED step's outputs stay unfinalized however its run
ended — so a run-level predicate would admit, one run away, exactly what this rule rejects
among the reading step's own siblings. One predicate over one table answers the question
for every branch.

When the completed-step snapshot is unavailable — the query that would have produced it
failed, so there is no set rather than an empty one — every read naming a producing step
for that exec (branches 3, 4, and 5 alike) SHALL be inadmissible. This fails closed, the
same posture the "trackInputAccess uses caller classification, else path fallback"
requirement specifies for its no-completed-step-set fallback: absence of an observation
SHALL NEVER be read as "every producing step completed". An unavailable snapshot SHALL
remain distinguishable from an obtained-but-empty one, because the resulting rejection is
counted with reason `snapshot-unavailable` rather than `producing-step-not-completed` (see
"feedExecFrame classifies each exec read from structured step context").

`dependsOn` remains scheduling-only and is still NOT read authorization: a step may
legitimately read a same-run sibling it never declared. But a sibling that has not
completed has no stable artifact to have been consumed, so completion — not declaration —
is the admissibility predicate.

The inadmissible outcome SHALL be an explicit result distinguishable from every
`source` classification (it is neither a `data` classification nor a thrown error), and
it SHALL carry the scraped step id so the caller can attribute the drop. `classifyReadPath`
SHALL remain pure: it receives `completedSteps` as its one admissibility argument and
SHALL NOT query any store to determine admissibility — not the step-execution table, and
not the run table, which this capability does not consult at all.

#### Scenario: Own-artifact read classified as artifacts

- **GIVEN** step `de` in run `run-002`
- **WHEN** classifying `runs/run-002/de/output/results.csv`
- **THEN** the result is `{ source: "artifacts", stepId: "de", runId: "run-002" }` and the completed-step set is not consulted

#### Scenario: dependsOn read of a completed step classified as upstream

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]` and a completed-step set containing the pair `(run-002, qc)`
- **WHEN** classifying `runs/run-002/qc/output/qc.csv`
- **THEN** the result is `{ source: "upstream", stepId: "qc", runId: "run-002" }`

#### Scenario: dependsOn sibling that has not completed is inadmissible

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]` and a completed-step set that does not contain `(run-002, qc)`
- **WHEN** classifying `runs/run-002/qc/output/qc.csv`
- **THEN** the result is the inadmissible outcome carrying step id `qc`, and no `upstream` classification is produced

#### Scenario: Same-run sibling that has not completed is inadmissible

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]` and a completed-step set containing the pair `(run-002, qc)`
- **WHEN** classifying `runs/run-002/norm/output/norm.csv` where `norm` is not in `dependsOn` and `(run-002, norm)` is not in the completed-step set
- **THEN** the result is the inadmissible outcome carrying step id `norm`, and the read is dropped rather than classified `upstream`

#### Scenario: Same-run sibling outside dependsOn that has completed is upstream

- **GIVEN** step `de` in run `run-002` with `dependsOn: ["qc"]` and a completed-step set containing the pairs `(run-002, qc)` and `(run-002, norm)`
- **WHEN** classifying `runs/run-002/norm/output/norm.csv` where `norm` is not in `dependsOn`
- **THEN** the result is `{ source: "upstream", stepId: "norm", runId: "run-002" }` — completion, not declaration, admits the edge

#### Scenario: Sibling observed running is inadmissible

- **GIVEN** step `de` in run `run-002` and sibling `T5S1` observed with status `running` at exec-submit time, so it is absent from the completed-step set
- **WHEN** classifying `runs/run-002/T5S1/output/_ct_for_r_BRAF.csv`
- **THEN** the result is the inadmissible outcome carrying step id `T5S1`, so two steps running in parallel have no lineage relationship

#### Scenario: Sibling observed failed is inadmissible

- **GIVEN** step `de` in run `run-002` and sibling `qc` observed with status `failed`, so it is absent from the completed-step set
- **WHEN** classifying `runs/run-002/qc/output/qc.csv`
- **THEN** the result is the inadmissible outcome carrying step id `qc`, because a failed step's outputs were never finalized

#### Scenario: Sibling that completed between submit and start is still inadmissible

- **GIVEN** step `de` in run `run-002` and sibling `norm`, which was `running` when `de`'s exec was submitted and reached `completed` before that exec started
- **WHEN** classifying `runs/run-002/norm/output/norm.csv` against the submit-time snapshot
- **THEN** the result is the inadmissible outcome carrying step id `norm` — the submit-time reading is deliberately stricter than a start-time reading, and SHALL NOT be relaxed to admit this edge

#### Scenario: Prior-run read of a completed step classified via path extraction

- **GIVEN** step `de` in run `run-002` and a completed-step set containing the pair `(run-001, de)`
- **WHEN** classifying `runs/run-001/de/output/prior.csv`
- **THEN** the pair tested is the one extracted from the path, and the result is `{ source: "prior", stepId: "de", runId: "run-001" }` — a prior run's completed step is admissible on the same predicate as a same-run sibling

#### Scenario: Prior-run read of a failed step is inadmissible

- **GIVEN** step `de` in run `run-002` and a prior run `run-001` whose step `qc` was observed `failed`, so `(run-001, qc)` is absent from the completed-step set even though `run-001` itself has finished
- **WHEN** classifying `runs/run-001/qc/output/partial.csv`
- **THEN** the result is the inadmissible outcome carrying step id `qc`, and no `prior` classification is produced — `qc` never finalized its outputs, and its run having finished does not change that

#### Scenario: Prior-run read of a step still running is inadmissible

- **GIVEN** step `de` in run `run-002` and another run `run-003` over the same workspace whose step `norm` is observed `running`, so `(run-003, norm)` is absent from the completed-step set
- **WHEN** classifying `runs/run-003/norm/output/norm.csv`
- **THEN** the result is the inadmissible outcome carrying step id `norm`, and no `prior` classification is produced — a running step is still mutating its directory whether or not it belongs to this run

#### Scenario: An unavailable snapshot makes every producing-step read inadmissible

- **GIVEN** step `de` in run `run-002` for which the completed-step snapshot query failed, so no completed-step set exists for this exec
- **WHEN** classifying `runs/run-002/qc/output/qc.csv`, where `qc` is a declared `dependsOn` sibling, and `runs/run-001/de/output/prior.csv`, a prior run's step
- **THEN** both results are the inadmissible outcome, carrying step ids `qc` and `de` respectively — classification fails closed and SHALL NOT treat the missing snapshot as "every producing step completed"

### Requirement: feedExecFrame classifies each exec read from structured step context

`feedExecFrame(args: FeedExecFrameArgs)` SHALL translate one sandbox-server exec
provenance frame into the step's `ProvenanceCollector`: for each read in the frame it
SHALL strip the `/{resourceId}/` mount prefix, classify the analysis-relative path with
`classifyReadPath(rel, collector.stepId, collector.runId, collector.dependsOn, completedSteps)`,
and record it via `collector.trackInputAccess(mountRoot, rel, null, context)`.

`feedExecFrame` SHALL receive the analysis-scoped set of `(runId, stepId)` pairs observed
`completed` at exec-submit time, and SHALL pass it through to `classifyReadPath`
unmodified. It SHALL receive no second, run-level admissibility input: one set answers for
same-run siblings and prior runs alike.

When classification returns the inadmissible outcome, `feedExecFrame` SHALL NOT call
`trackInputAccess` for that read. The ref never enters the collector, so it never becomes
an attestation target and can never be registered as a lineage edge.

Each rejection SHALL be observable: `feedExecFrame` SHALL log it through the injected
`Logger` seam with the ref path, the scraped step id, and that step's observed status as
structured fields, and SHALL increment the `lineageEdgeRejected` metric
(`cortex.lineage.edge_rejected`), tagged `agent_id`, `step_id`, and `reason`. `reason`
SHALL be one of exactly two values:

- `producing-step-not-completed` — a snapshot was obtained and the producing step's `(runId, stepId)` pair was not in it. This covers the same-run sibling and the prior-run step identically, because they are rejected by one rule and separating them would imply two;
- `snapshot-unavailable` — no observation existed for this exec, so the read failed closed.

`lineageEdgeRejected` SHALL be a counter of its own, distinct from reconcile's
`lineageInputDropped` (`cortex.artifact.reconcile.input_dropped`). The two count different
events at different sites, and this change SHALL NOT add a reason to the reconcile
counter: its `reason` set stays exactly `directory`, `container-prefix`, and
`workspace-root` (see the `artifact-manifest` capability).

It SHALL remain best-effort: a disabled or absent frame records the command with no
inputs and no writes, an inadmissible read is dropped rather than fatal, and it SHALL NOT
throw.

#### Scenario: Frame read of a completed sibling classified from collector context

- **GIVEN** a collector for step `de` in run `run-002` with `dependsOn: ["qc"]` and a completed-step set containing the pair `(run-002, qc)`
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-002/qc/output/qc.csv`
- **THEN** `trackInputAccess` is called with context `{ source: "upstream", stepId: "qc", runId: "run-002" }`

#### Scenario: Frame read of a running sibling is dropped before the collector

- **GIVEN** a collector for step `T4S1` in run `run-002` and sibling `T2S2` observed `running` at exec-submit time
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-002/T2S2/logs/run_gsea.log`
- **THEN** `trackInputAccess` is not called for that read, the ref is absent from the collector's inputs, and no attestation target is created for it

#### Scenario: Rejected sibling edge is logged and metered

- **GIVEN** a collector for step `T4S1` in run `run-002` and sibling `T2S2` observed `running` at exec-submit time
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-002/T2S2/output/wikipathways_symbols.gmt`
- **THEN** a record is emitted through the injected `Logger` carrying the ref path, step id `T2S2`, and status `running`, and `lineageEdgeRejected` is incremented with `reason = "producing-step-not-completed"`
- **AND** `lineageInputDropped` is NOT incremented for that read

#### Scenario: Rejected prior-run edge is metered under the same reason

- **GIVEN** a collector for step `de` in run `run-002` and a prior run `run-001` whose step `qc` was observed `failed`, so `(run-001, qc)` is absent from the completed-step set
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-001/qc/output/partial.csv`
- **THEN** `trackInputAccess` is not called for that read and `lineageEdgeRejected` is incremented with `reason = "producing-step-not-completed"` — the same reason a same-run sibling's rejection carries, because it is the same rule

#### Scenario: Prior-run read of a completed step reaches the collector

- **GIVEN** a collector for step `de` in run `run-002` and a completed-step set containing the pair `(run-001, qc)`
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-001/qc/output/qc.csv`
- **THEN** `trackInputAccess` is called with context `{ source: "prior", stepId: "qc", runId: "run-001" }` and `lineageEdgeRejected` is not incremented

#### Scenario: An unavailable snapshot is metered as its own reason

- **GIVEN** a collector for step `de` in run `run-002` whose completed-step snapshot query failed, so no set was supplied for this exec
- **WHEN** a frame reports a read of `/{resourceId}/runs/run-002/qc/output/qc.csv`
- **THEN** the read is dropped before the collector and `lineageEdgeRejected` is incremented with `reason = "snapshot-unavailable"`, distinguishing a failed observation from a producing step observed not-completed

#### Scenario: Inadmissible read does not fail the exec

- **WHEN** every read in a frame classifies as inadmissible
- **THEN** `feedExecFrame` records the command execution with those reads dropped and does not throw

#### Scenario: Disabled frame records the command with no inputs

- **WHEN** `feedExecFrame` is called with a `provenance` frame marked `disabled`
- **THEN** it records the command execution with no inputs and no writes, and does not throw

### Requirement: trackInputAccess uses caller classification, else path fallback

`ProvenanceCollector.trackInputAccess(mountPath, relativePath, hash, context?)` SHALL use
a provided `InputClassificationContext` directly; when none is provided it SHALL fall
back to `classifyReadPath` over its own `stepId`/`runId`/`dependsOn`. Re-reading the same
`mountPath:relativePath` SHALL return the already-tracked ref.

The fallback SHALL fail closed. When no completed-step set is available to the collector,
a path that resolves to a producing step SHALL be treated as INADMISSIBLE: a same-run
sibling (branch 3 or branch 4) SHALL NOT be tracked as an `upstream` input, and another
run's step (branch 5) SHALL NOT be tracked as a `prior` input. One missing observation
disqualifies both, because both are decided by the same predicate. The no-context path
therefore cannot silently reintroduce an ungated edge of either kind, and absence of an
observation SHALL never be read as "every producing step completed" — this is the same
fail-closed posture "classifyReadPath resolves five classification branches by prefix"
specifies for an unavailable snapshot, stated here for the collector's own fallback rather
than contradicting it. The `data` and `artifacts` branches of the fallback SHALL keep
their current behaviour.

#### Scenario: Caller provides upstream classification

- **WHEN** `trackInputAccess(mountPath, relativePath, null, { source: "upstream", stepId: "qc", runId: "run-002" })` is called
- **THEN** the resulting InputRef has `source: "upstream"`, `stepId: "qc"`, `runId: "run-002"` and no path parsing occurs

#### Scenario: No context falls back to path classification

- **WHEN** `trackInputAccess(mountPath, relativePath, null)` is called without a context for a `data/` path
- **THEN** the collector classifies the read via `classifyReadPath` using its own `stepId`/`runId`/`dependsOn`, yielding `{ source: "data" }`

#### Scenario: No-context sibling read fails closed

- **GIVEN** a collector for step `de` in run `run-002` with no completed-step set available
- **WHEN** `trackInputAccess(mountPath, "runs/run-002/norm/output/norm.csv", null)` is called without a context
- **THEN** the read is treated as inadmissible and no `upstream` InputRef is tracked for it

#### Scenario: No-context prior-run read fails closed

- **GIVEN** a collector for step `de` in run `run-002` with no completed-step set available
- **WHEN** `trackInputAccess(mountPath, "runs/run-001/de/output/prior.csv", null)` is called without a context
- **THEN** the read is treated as inadmissible and no `prior` InputRef is tracked for it, even though `run-001` has long since finished

#### Scenario: Re-read returns the already-tracked ref

- **GIVEN** `trackInputAccess` has already tracked `mountPath:relativePath`
- **WHEN** the same `mountPath:relativePath` is tracked again
- **THEN** the already-tracked ref is returned and no reclassification occurs

### Requirement: Prior-run classification is the one documented path-extraction fallback

Path-segment extraction SHALL be confined to the classification branches that genuinely
have no structured alternative — the same-run sibling branch (branch 4), which scrapes the
step id, and the prior-run branch (branch 5), which scrapes the run and step ids — and
SHALL NOT appear in any other branch. The prior-run branch is no longer the only such
site: branch 4 also extracts a step id from the path, so "the one path-extraction
fallback" SHALL be read as the confinement rule, not as a count.

Each extraction site SHALL carry an in-code comment stating why the fallback exists there:
a read under `runs/{ownRunId}/{otherStepId}/…` matches neither the step's own ids nor a
`dependsOn` entry, and a read under `runs/{otherRunId}/…` matches neither the step's own
run nor a `dependsOn` entry, so in both cases the path segments are the only available
source for the identity the outcome carries — `{source: "prior", runId, stepId}` for
branch 5, and the producing step id for branch 4. The comment SHALL describe only code
that exists — it SHALL NOT reference declarations, types, or plumbing absent from the
tree.

The extracted identity SHALL also be the key the gate tests, not merely a label on the
result: branch 5 SHALL look up the `(runId, stepId)` pair it scraped from the path, and
branch 4 SHALL look up its scraped step id paired with `ownRunId`. Extraction that
produced the outcome's identity but not the membership test would let a branch classify
one step while admitting on the strength of another.

Branch 4's and branch 5's scraped ids SHALL survive rejection: when either branch yields
the inadmissible outcome, the extracted id SHALL ride on that outcome, because it is the
only thing that makes the drop attributable to a producing step in the drop record's
structured fields (see "feedExecFrame classifies each exec read from structured step
context"). An inadmissible outcome that carries no step id SHALL NOT be conformant.

#### Scenario: Comment exists at each extraction site

- **WHEN** a developer reads the same-run sibling branch and the prior-run classification branch
- **THEN** each carries a comment stating why path extraction is the only source for the identity that branch produces, with no references to nonexistent declarations
- **AND** no other classification branch parses path segments

#### Scenario: A rejected sibling read still names its producing step

- **GIVEN** step `de` in run `run-002` and a read of `runs/run-002/norm/output/norm.csv` where `(run-002, norm)` is absent from the completed-step set
- **WHEN** the path is classified
- **THEN** the inadmissible outcome carries the scraped step id `norm`, so the drop is attributable in logs rather than anonymous

#### Scenario: The pair scraped from a prior-run path is the key the gate tests

- **GIVEN** step `de` in run `run-002`, a read of `runs/run-001/qc/output/qc.csv`, and a completed-step set containing `(run-002, qc)` but not `(run-001, qc)`
- **WHEN** the path is classified
- **THEN** the pair looked up is `(run-001, qc)` — the one extracted from the path — so the result is the inadmissible outcome carrying step id `qc`, and the same-run `qc` entry does NOT admit it
- **AND** a rejected prior-run read carries its scraped step id exactly as a rejected sibling read does
