# prov-harness-bridge Specification (delta)

## MODIFIED Requirements

### Requirement: The artifact-registry bus adapter translates registration into provenance events

The cli SHALL provide an `ArtifactRegistry` realization (the bus adapter, in
`src/modules/harness/`) whose `register(input, session)` translates one step's
registration into bus events and nothing else. The adapter emits FILE and USED-INPUT
events only — step lifecycle events come from the harness's scheduler settlement (see
the callback requirement), because registration is skipped entirely for steps whose
reconciled manifest is empty and never reached by failed steps:

- Emit `prov.file_written` once per manifest entry, stamped with the system actor
  and `analysisId = input.resourceId`.
- Manifest entries arrive STEP-relative (e.g. `output/results.csv`); the adapter
  SHALL scope each to the analysis-scoped form (`runs/{runId}/{stepId}/…`) and use
  that one string for the event path, the file-QName seed, and the
  `registered[].path` write-back key — the harness matches its `cortex_artifacts`
  rows by exactly that path, and an unscoped path would both no-op the external-id
  write-back and collide same-named files across steps.
- `producer` SHALL be resolved by joining the RAW step-relative entry path against
  the collector's records (`producer.type` — the collector also keys step-relative),
  defaulting to `"command"` when no record matches (an observed sandbox write
  without an in-process producer record is a command effect).
- Emit `prov.input_used` once per tracked input ref (`collector.getTrackedInputs()`),
  SKIPPING refs with `source: "artifacts"` (the step's own outputs, mirroring the
  reconcile-time skip). The ref's container-absolute path (`/{resourceId}/…`) SHALL
  be stripped to analysis-relative; the attested hash passes through.
- An entry or input ref missing its content hash SHALL be reported in `failed` (and
  counted in `failedCount`) instead of emitted — content-attestation is guaranteed
  upstream (reconcile rehashes entries; `fillInputHashesFromDisk` fails the step on
  an unattestable input), so a hash-less record here signals an upstream defect.
- The result SHALL report each emitted entry in `registered` with the file's
  deterministic PROV QName as `externalId`.
- `sync()` SHALL be a local no-op — the artifact bytes already live on host disk.
- The adapter SHALL NOT write to `cortex_artifacts` or any harness-owned table (the
  seam contract) and SHALL NOT emit `prov.step_completed`.

#### Scenario: One step's registration becomes file and input events

- **WHEN** `register` is called with three reconciled manifest entries and two tracked non-artifacts input refs for step `de-analysis` of run `run-001`
- **THEN** the bus receives three `prov.file_written` events (analysis-scoped paths, hashes, sizes, producers) and two `prov.input_used` events (analysis-relative paths, attested hashes, sources) — and NO `prov.step_completed`; the result lists three `registered` entries whose `externalId` values are the files' PROV QNames with `failedCount: 0`

#### Scenario: Producer resolution falls back to command

- **WHEN** a manifest entry has no matching collector record for its path
- **THEN** its `prov.file_written` event carries `producer: "command"`

#### Scenario: A hash-less record fails registration instead of degrading provenance

- **WHEN** a manifest entry or a tracked input ref arrives without a content hash
- **THEN** no event is emitted for it and the result reports it in `failed` with a named error, incrementing `failedCount`

### Requirement: The harness exposes an optional run-lifecycle provenance callback

`ExecuteAnalysisDeps` SHALL carry an optional `emitProvenance?: (event:
RunProvenanceEvent) => void` dependency. `RunProvenanceEvent` SHALL be a
harness-owned plain union — the harness remains tsprov-free and bus-free — whose
timestamps are epoch-ms read via `DBOS.now()` (a checkpointed step, so re-executed
bodies re-emit identical values):

- `{ type: "run_started"; analysisId; runId; planSummary; stepCount; atMs }`, emitted
  at the run-started boundary (beside the `data-run-started` stream part).
- `{ type: "step_completed"; analysisId; runId; stepId; status; durationMs?; atMs }`,
  emitted at EVERY scheduler-loop settlement branch — the only site that observes
  every executed step. `status` maps the settlement outcome: `complete` →
  `"completed"`, `canceled` → `"canceled"`, `failed`/`blocked`/child-error →
  `"failed"`; `durationMs` is the child's durable result duration where present.
  Steps that were never dispatched (dependents of a failed sibling) emit nothing —
  they never executed, and the run's terminal status carries that outcome.
- `{ type: "run_completed"; analysisId; runId; status; atMs; durationMs }`, emitted
  at BOTH terminal boundaries (beside `data-run-completed` AND `data-run-failed`),
  where `status` is the body's terminal status (`RunStatus` minus `running`) and
  `durationMs = atMs − the run_started atMs`.

Call sites SHALL invoke the callback directly in the workflow body (not wrapped in a
DBOS step — body re-execution on recovery must re-fire the emission) and SHALL guard
it so a throwing observer never fails the run. When the dependency is absent the
workflow behaves exactly as before.

#### Scenario: A zero-artifact step is still recorded

- **WHEN** a step completes without producing any registrable artifact (empty reconciled manifest)
- **THEN** `emitProvenance` still receives `step_completed` with `status: "completed"` from the settlement site — the step appears in the signed document even though registration never ran

#### Scenario: Failed and canceled steps are recorded with their status

- **WHEN** one step fails and the fail-fast cascade cancels an in-flight sibling
- **THEN** `emitProvenance` receives `step_completed` with `status: "failed"` for the first and `status: "canceled"` for the sibling, while a dependent step that was never dispatched produces no event

#### Scenario: Replay re-emits identical timestamps

- **WHEN** DBOS recovery re-executes the workflow body after a host kill
- **THEN** every re-fired event carries the same `atMs`/`durationMs` values as the original emission (checkpointed clock reads), so the recorded activities merge without value conflicts

#### Scenario: Absent callback changes nothing

- **WHEN** `ExecuteAnalysisDeps` is built without `emitProvenance`
- **THEN** the workflow runs identically to the pre-change behavior

### Requirement: The cli realizes the callback as bus emission with the system actor

The cli composition SHALL realize `emitProvenance` by mapping all three harness arms
to bus events: `run_started` → `prov.run_started` (run ref with `planSummary` and
`startedAtMs`), `step_completed` → `prov.step_completed` (a `ProvStepOutcome` with
the settlement status, `completedAtMs`, and duration), and `run_completed` →
`prov.run_completed` (outcome with status, `completedAtMs`, and duration) — each
stamped with the existing system actor (cli version + commit). The mapping SHALL use
the harness-supplied `analysisId` unchanged and SHALL pass timestamps through without
re-reading any clock.

#### Scenario: Every executed step lands in the signed document

- **WHEN** `inflexa run` executes a plan where one step succeeds with artifacts, one succeeds with none, and one fails
- **THEN** the signed provenance document contains three step activities carrying statuses `completed`, `completed`, and `failed` — with true settlement times and durations

#### Scenario: A run whose host process ended is still recorded on recovery

- **WHEN** the cli process ends mid-run (detach, crash, or kill) and a later boot's DBOS recovery re-executes the workflow to a terminal status
- **THEN** the re-executed body re-fires `emitProvenance`, the recorder records the completion, and the unified document contains a single run activity whose times equal the original workflow-observed times
