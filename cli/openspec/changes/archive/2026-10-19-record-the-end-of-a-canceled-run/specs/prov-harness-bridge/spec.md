## ADDED Requirements

### Requirement: The cancel route records the end of the run that it cancels

The cli MUST build the run canceler of its cancel route with the `ProvenanceSeam` that the boot installed. The canceler then emits the end of a run that it cancels through the run emit of that value. The realization maps the events as for the body. Thus an aborted run gets `prov.step_completed` with the status `canceled` for each cut step, and `prov.run_completed` with the status `canceled`.

The recorder signs these events into the document of the analysis. The agent switch and the activity time read the same `prov.run_completed`. When no boot installed one, the canceler gets none, and the cancel converges with no provenance.

#### Scenario: The production canceler carries the installed provenance binding

- **GIVEN** a boot that installed a `ProvenanceSeam`
- **WHEN** the cancel route makes the deps of its production canceler
- **THEN** the deps carry that exact value
- **AND** with none installed, the deps carry none

#### Scenario: An aborted run ends in the signed document

- **GIVEN** a running run with one cut step, and an installed `ProvenanceSeam`
- **WHEN** the cancel route cancels the run, and the terminal write of the canceler wins
- **THEN** the document of the analysis holds the run activity with an end time and the status `canceled`
- **AND** it holds the activity of the cut step with the status `canceled`, associated with the model agent

#### Scenario: An aborted run leaves the agent-switch gauge

- **GIVEN** a model selection that waits for idle, and the aborted run as the only work in progress
- **WHEN** the cancel route cancels the run, and the terminal write of the canceler wins
- **THEN** the gauge leaves the run, and the waiting selection applies

## MODIFIED Requirements

### Requirement: The harness exposes an optional run-lifecycle provenance callback

The harness MUST carry the run emit as the `emitRunEvent` member of its `ProvenanceSeam`, with the signature `(event: RunProvenanceEvent, session: AgentSession) => void`. An implementation can ignore the session parameter, thus a realization that reads only the event stays correct. `RunProvenanceEvent` MUST be a harness-owned plain union, with no tsprov import and no bus import in the harness API. The harness uses tsprov only as a report page asset, as bytes, and a harness lint rule MUST ban every tsprov API import. The other seam shapes, `SessionProvenanceEvent` and `ProvenanceExport`, obey the same plain-shape rule. The workflow body reads its timestamps with `DBOS.now()`, a checkpointed step, thus a re-executed body emits identical values. The run canceler is the second emit site. It reads the wall clock one time for the events of one cancel, because no replay fires them again:

- `{ type: "run_started"; analysisId; runId; planSummary; stepCount; atMs }`, emitted at the run-started boundary, beside the `data-run-started` stream part.
- `{ type: "step_completed"; analysisId; runId; stepId; status; durationMs?; atMs }`, emitted at EVERY scheduler-loop settlement branch — the only site that observes every executed step. `status` maps the settlement outcome: `complete` → `"completed"`, `canceled` → `"canceled"`, and `failed`, `blocked`, or a child error → `"failed"`. `durationMs` is the durable result duration of the child where present. A step that was never dispatched, as the dependent of a failed sibling, emits nothing. It never executed, and the terminal status of the run carries that outcome. The run canceler also emits it, with `"canceled"`, for each step that its cancel cut, when its terminal write wins.
- `{ type: "run_completed"; analysisId; runId; status; atMs; durationMs }`, emitted at BOTH terminal boundaries of the body, beside `data-run-completed` AND `data-run-failed`. `status` is the terminal status of the body, `RunStatus` minus `running`, and `durationMs = atMs − the run_started atMs`. The run canceler also emits it, with `"canceled"`, when its terminal write wins. Its `durationMs` is `atMs` minus the start time of the run row, not less than 0.

A call site in the workflow body MUST invoke the member directly, never inside a DBOS step. Body re-execution on recovery must fire the emission again. Each call site MUST guard it, thus a throwing observer never fails the run or the cancel. When the member is absent, the workflow behaves exactly as before.

#### Scenario: A zero-artifact step is still recorded

- **WHEN** a step completes without producing any registrable artifact (empty reconciled manifest)
- **THEN** the run emit still receives `step_completed` with `status: "completed"` from the settlement site — the step appears in the signed document although registration never ran

#### Scenario: Failed and canceled steps are recorded with their status

- **WHEN** one step fails and the fail-fast cascade cancels an in-flight sibling
- **THEN** the run emit receives `step_completed` with `status: "failed"` for the first and `status: "canceled"` for the sibling. A dependent step that was never dispatched produces no event

#### Scenario: Replay re-emits identical timestamps

- **WHEN** DBOS recovery re-executes the workflow body after a host kill
- **THEN** every re-fired event carries the same `atMs` and `durationMs` values as the original emission, thus the recorded activities merge without value conflicts

#### Scenario: Absent member changes nothing

- **WHEN** the composition binds no run emit member
- **THEN** the workflow runs identically to the pre-change behavior

#### Scenario: A won cancel emits the end of the run

- **WHEN** the run canceler cancels a running run with one cut step, and its terminal write wins
- **THEN** the run emit receives `step_completed` with `status: "canceled"` for the cut step, then `run_completed` with `status: "canceled"`, each with the session of the cancel
