# prov-run-events Specification (delta)

## ADDED Requirements

### Requirement: Execution-level provenance events exist in the bus contract

The `BusEvent` union SHALL carry four execution-level provenance events, each scoped
by `analysisId` and stamped with a `ProvActor`:

- `prov.run_started` — carries `run: ProvRunRef { runId, planSummary? }`.
- `prov.run_completed` — carries `outcome: ProvRunOutcome { runId, status, durationMs? }`
  where `status` is the harness's terminal run vocabulary:
  `"completed" | "partial" | "failed" | "canceled" | "suspended_insufficient_funds"`.
- `prov.step_completed` — carries `step: ProvStepRef { runId, stepId, durationMs? }`.
  `ProvStepRef` SHALL NOT carry `command` or `exitCode` — those are per-output-file
  facts in the harness's producer model, not per-step facts.
- `prov.file_written` — carries `file: ProvFileRef { path, hash, size, producer }` and
  the producing `step: ProvStepRef`. `producer` SHALL be the bare discriminant
  `"command" | "file_tool"`, matching the harness `Producer.type` vocabulary. `path`
  SHALL be analysis-scoped (`runs/{runId}/{stepId}/…`).

The domain types SHALL live in `src/types/prov.ts` and the events in
`src/types/events.ts`, following the one-event-per-domain-action bus rule. The bus
telemetry projection SHALL surface identifying fields for each event (runId; runId +
status; runId + stepId; path + producer respectively).

#### Scenario: Events carry their identifying payloads

- **WHEN** a `prov.run_completed` event is emitted for run `run-001` with status `partial`
- **THEN** the event carries `analysisId`, the actor, and `outcome: { runId: "run-001", status: "partial" }`, and the bus telemetry projection includes the runId and status

#### Scenario: Step events carry no command-level fields

- **WHEN** a `prov.step_completed` event is constructed
- **THEN** its `ProvStepRef` type admits only `runId`, `stepId`, and optional `durationMs` — command strings and exit codes have no per-step representation

### Requirement: Document builders append deterministic, PROV-valid execution records

The prov module SHALL provide four builders — `appendRunStarted`,
`appendRunCompleted`, `appendStepCompleted`, `appendFileWritten` — that append W3C
PROV records to an analysis's live document. Runs and steps SHALL be recorded as
PROV **activities**; files as PROV **entities**:

- `appendRunStarted`: a run activity (`prov:type: inflexa:Run`, start time, `runId`,
  optional `planSummary`), `wasAssociatedWith` the actor's agent, and a `used` edge
  from the run activity to the analysis entity. The run SHALL NOT re-generate the
  analysis entity (`appendCreation` is the analysis's single generation).
- `appendRunCompleted`: the SAME run activity QName re-declared with an end time and
  outcome attributes (`status`, optional `durationMs`) — never a same-QName entity.
- `appendStepCompleted`: a step activity (`prov:type: inflexa:Step`, end time,
  `runId`, `stepId`, optional `durationMs`), `wasInformedBy` the run activity, and
  `wasAssociatedWith` the actor's agent.
- `appendFileWritten`: a file entity (`prov:type: inflexa:File`, `path`, `hash`,
  `size`, `producer`), `wasGeneratedBy` the step activity, `wasAttributedTo` the
  actor's agent, and `wasDerivedFrom` the analysis entity (the coarse lineage edge —
  no per-input edges in this cut).

Every QName SHALL be deterministic from event content: `inflexa:run-{runId}`,
`inflexa:step-{runId}-{stepId}`, and a file QName derived from `(path, hash)`. The
builders SHALL NOT mint per-event action activities (no random-UUID QNames on the
execution path).

#### Scenario: Run start and completion merge into one activity

- **WHEN** `appendRunStarted` and `appendRunCompleted` are applied for the same runId and the document is unified
- **THEN** the document contains exactly one `inflexa:run-{runId}` activity carrying the start time, the end time, and the outcome status — and no entity under that QName

#### Scenario: File generation references a valid activity

- **WHEN** `appendStepCompleted` and `appendFileWritten` are applied for a step and its output file
- **THEN** the file entity's `wasGeneratedBy` references the step's activity QName, and the PROV-N export renders `inflexa:Run`, `inflexa:Step`, and `inflexa:File` records

#### Scenario: Round-trip through PROV-JSON

- **WHEN** a document with run, step, and file records is unified, serialized to PROV-JSON, and deserialized
- **THEN** the parsed document equals the unified original

### Requirement: Replay-idempotent recording

Recording SHALL be replay-idempotent: re-emitting an execution-level event (as DBOS
workflow re-execution does on recovery) MUST NOT structurally duplicate PROV
records — after `unified()`, the document SHALL contain one record set per
deterministic QName regardless of how many times the same event was recorded.

#### Scenario: Duplicate emission dedups by QName

- **WHEN** the same `prov.run_started` and `prov.step_completed` events are emitted twice and the document is flushed and unified
- **THEN** the serialized document contains one run activity and one step activity, not two of each

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
