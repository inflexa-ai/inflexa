# prov-run-events Specification

## Purpose
TBD - created by archiving change bridge-harness-provenance. Update Purpose after archive.
## Requirements
### Requirement: Execution-level provenance events exist in the bus contract

The `BusEvent` union SHALL carry five execution-level provenance events, each scoped
by `analysisId` and stamped with a `ProvActor`. Timestamps in these payloads are
epoch-milliseconds observed by the harness via its checkpointed clock — replay-stable
by construction, never minted by the cli recorder:

- `prov.run_started` — carries `run: ProvRunRef { runId, planSummary?, startedAtMs }`.
- `prov.run_completed` — carries `outcome: ProvRunOutcome { runId, status,
  completedAtMs, durationMs? }` where `status` is the harness's terminal run
  vocabulary: `"completed" | "partial" | "failed" | "canceled" |
  "suspended_insufficient_funds"`.
- `prov.step_completed` — carries `outcome: ProvStepOutcome { runId, stepId, status,
  completedAtMs, durationMs? }` where `status` is the step-settlement vocabulary
  `"completed" | "failed" | "canceled"`. `ProvStepOutcome` SHALL NOT carry `command`
  or `exitCode` — those are per-output-file facts in the harness's producer model.
- `prov.file_written` — carries `file: ProvFileRef { path, hash, size, producer }` and
  the producing `step: ProvStepRef { runId, stepId }` (the pure step reference —
  settlement facts live only on `ProvStepOutcome`). `producer` SHALL be the bare
  discriminant `"command" | "file_tool"`. `path` SHALL be analysis-scoped
  (`runs/{runId}/{stepId}/…`).
- `prov.input_used` — carries the reading `step: ProvStepRef` and `input:
  ProvUsedInputRef { path, hash, source, fileId? }` where `source` is the harness's
  read-classification vocabulary minus the step's own outputs: `"data" | "upstream" |
  "prior"`. `path` SHALL be analysis-relative (container mount prefix stripped);
  `hash` SHALL be the content-attested hash the harness filled from disk.

The domain types SHALL live in `src/types/prov.ts` and the events in
`src/types/events.ts`, following the one-event-per-domain-action bus rule. The bus
telemetry projection SHALL surface identifying fields for each event (runId; runId +
status; runId + stepId + status; path + producer; path + source respectively).

#### Scenario: Step outcomes carry settlement facts

- **WHEN** a `prov.step_completed` event is emitted for step `step-de` of run `run-001` that failed after 90 seconds
- **THEN** the event carries `outcome: { runId: "run-001", stepId: "step-de", status: "failed", completedAtMs, durationMs: 90000 }`, and the telemetry projection includes the runId, stepId, and status

#### Scenario: Used inputs carry attested identity

- **WHEN** a `prov.input_used` event is emitted for a step that read a staged data file
- **THEN** the event carries the analysis-relative path, the content hash attested from disk, and `source: "data"` — never a hash-less reference

### Requirement: Document builders append deterministic, PROV-valid execution records

The prov module SHALL provide five builders — `appendRunStarted`,
`appendRunCompleted`, `appendStepCompleted`, `appendFileWritten`, `appendInputUsed` —
that append W3C PROV records to an analysis's live document. Runs and steps SHALL be
recorded as PROV **activities**; files and used inputs as PROV **entities**:

- `appendRunStarted`: a run activity (`prov:type: inflexa:Run`, `runId`, optional
  `planSummary`) whose formal start time is the ISO form of the payload's
  `startedAtMs`; `wasAssociatedWith` the actor's agent; a `used` edge from the run
  activity to the analysis entity. The run SHALL NOT re-generate the analysis entity.
- `appendRunCompleted`: the SAME run activity QName re-declared with the formal end
  time from `completedAtMs` and outcome attributes (`status`, optional `durationMs`) —
  never a same-QName entity.
- `appendStepCompleted`: a step activity (`prov:type: inflexa:Step`, `runId`,
  `stepId`, `status`, optional `durationMs`) with the formal end time from
  `completedAtMs`; `wasInformedBy` the run activity; `wasAssociatedWith` the actor's
  agent.
- `appendFileWritten`: a file entity (`prov:type: inflexa:File`, `path`, `hash`,
  `size`, `producer`), `wasGeneratedBy` the step activity, `wasAttributedTo` the
  actor's agent, and `wasDerivedFrom` the analysis entity.
- `appendInputUsed`: an input entity keyed in the SAME `(path, hash)` file-QName
  space as outputs (`inflexa:path`, `inflexa:hash`, `inflexa:source`, optional
  `inflexa:fileId`), and a `used` edge from the step activity to it. Because the key
  space is shared, a `source: "prior"` read of an earlier run's output resolves to
  the same entity that run's `prov.file_written` generated — cross-run lineage chains
  merge without additional modeling.

Formal time positions SHALL be populated ONLY from event-payload timestamps — a
builder never reads the wall clock into a formal attribute (the `occurrenceTime()`
first-observed guard remains as defense in depth, not as the time source). Every
element QName SHALL be deterministic from event content (`inflexa:run-{runId}`,
`inflexa:step-{runId}-{stepId}`, file/input QNames from `(path, hash)`), every
relation record SHALL carry a deterministic identifier derived from its endpoint
tuple, and relation records SHALL carry NO formal time. The builders SHALL NOT mint
per-event action activities.

#### Scenario: Run times are the harness-observed times

- **WHEN** `appendRunStarted` and `appendRunCompleted` are applied with payload timestamps and the document is unified
- **THEN** the single `inflexa:run-{runId}` activity carries `prov:startTime`/`prov:endTime` equal to the ISO forms of `startedAtMs`/`completedAtMs` — not the cli's append-time clock — plus the outcome status and duration

#### Scenario: A prior-run read chains to its producing step

- **WHEN** run 2's step reads `runs/run-001/step-de/output/results.csv` (unchanged bytes) and `appendInputUsed` is applied
- **THEN** the used-input entity's QName equals the entity `appendFileWritten` created for that file in run 1, and the unified document contains one entity generated by run 1's step and used by run 2's step

#### Scenario: Round-trip through PROV-JSON

- **WHEN** a document with run, step, file, and used-input records is unified, serialized to PROV-JSON, and deserialized
- **THEN** the parsed document equals the unified original

### Requirement: Replay-idempotent recording

Recording SHALL be replay-idempotent: re-emitting an execution-level event (as DBOS
workflow re-execution does on recovery) MUST NOT structurally duplicate PROV
records — after `unified()`, the document SHALL contain one record set per
deterministic identifier (elements AND relations) regardless of how many times the
same event was recorded. Additionally, a conflicting single-valued formal attribute
MUST NOT prevent persistence: the cli's `unified()` invocations on the persistence
and export paths SHALL pass tsprov's `formalAttributeConflict: "first"` policy, so a
value conflict degrades to keep-first-plus-log instead of an unfushable analysis.

#### Scenario: Duplicate emission dedups by deterministic identifier

- **WHEN** the same `prov.run_started` and `prov.step_completed` events are emitted twice and the document is flushed and unified
- **THEN** the serialized document contains one run activity, one step activity, and ONE of each relation record — not two

#### Scenario: A formal-time conflict cannot poison the flush

- **WHEN** the live document somehow holds two same-QName activity records whose formal times differ (a defect upstream of the builders' determinism)
- **THEN** the flush still unifies, signs, and persists — the first-recorded time survives and the conflict is logged — rather than throwing on every retry and leaving the analysis permanently unfushable

### Requirement: Execution events flow through the existing recorder and signing path

The provenance recorder SHALL handle the four execution events exactly as the
analysis-lifecycle events: load-or-create the live document for `event.analysisId`,
append via the matching builder, mark dirty, and debounce-flush through the
unchanged chain-hash + Ed25519 signing path. Events whose `analysisId` has no
analysis row SHALL be dropped (the existing recorder guard). Signing failure SHALL
crash the flush — provenance is never degraded to unsigned.

#### Scenario: Bus emission lands in the signed column

- **WHEN** `prov.run_started`, `prov.step_completed`, and `prov.file_written` are emitted for a known analysis and the recorder flushes
- **THEN** `analyses.provenance` holds a PROV-JSON document containing the run, step, and file records, with the chain hash and signature updated

#### Scenario: Unknown analysis is dropped silently

- **WHEN** an execution event references an `analysisId` with no analysis row
- **THEN** the recorder ignores the event and no document is created or modified

