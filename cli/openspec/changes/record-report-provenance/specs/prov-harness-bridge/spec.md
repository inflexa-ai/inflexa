# prov-harness-bridge — delta

## MODIFIED Requirements

### Requirement: The harness exposes an optional run-lifecycle provenance callback

The harness MUST carry the run emit as the `emitRunEvent` member of its `ProvenanceSeam`, with the signature `(event: RunProvenanceEvent, session: RunSession) => void`. An implementation can ignore the session parameter, thus a realization that reads only the event stays correct. `RunProvenanceEvent` MUST be a harness-owned plain union, with no tsprov import and no bus import in the harness API. The harness uses tsprov only as a report page asset, as bytes, and a harness lint rule MUST ban every tsprov API import. The other seam shapes, `SessionProvenanceEvent` and `ProvenanceExport`, obey the same plain-shape rule. Timestamps are epoch-ms read with `DBOS.now()`, a checkpointed step, thus a re-executed body emits identical values:

- `{ type: "run_started"; analysisId; runId; planSummary; stepCount; atMs }`, emitted at the run-started boundary, beside the `data-run-started` stream part.
- `{ type: "step_completed"; analysisId; runId; stepId; status; durationMs?; atMs }`, emitted at EVERY scheduler-loop settlement branch — the only site that observes every executed step. `status` maps the settlement outcome: `complete` → `"completed"`, `canceled` → `"canceled"`, and `failed`, `blocked`, or a child error → `"failed"`. `durationMs` is the durable result duration of the child where present. A step that was never dispatched, as the dependent of a failed sibling, emits nothing. It never executed, and the terminal status of the run carries that outcome.
- `{ type: "run_completed"; analysisId; runId; status; atMs; durationMs }`, emitted at BOTH terminal boundaries, beside `data-run-completed` AND `data-run-failed`. `status` is the terminal status of the body, `RunStatus` minus `running`, and `durationMs = atMs − the run_started atMs`.

Call sites MUST invoke the member directly in the workflow body, never inside a DBOS step. Body re-execution on recovery must fire the emission again. Call sites MUST guard it, thus a throwing observer never fails the run. When the member is absent, the workflow behaves exactly as before.

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

## ADDED Requirements

### Requirement: The cli realizes the provenance seam as one bridge

The cli MUST realize the whole `ProvenanceSeam` in `src/modules/harness/prov_bridge.ts`, and the composition root MUST bind one seam object on the core bag. The session emit maps each seam event onto its report bus member. It stamps the system actor, and it carries the model that drives the session at emit time. The run emit keeps its construction-time model stamp, refreshed through the swap of the agent switch. The cli MUST pass the same bound seam into `PrepareChatTurnDeps` at its chat-turn call site. The conversation creation emits there, and the core bag does not reach it.

#### Scenario: A created report session reaches the bus

- **WHEN** the harness emits `create-session` with kind `report` and a parent thread
- **THEN** the bridge publishes `prov.session_created` with the thread id, the kind, the parent thread id, and the actor

#### Scenario: A block act carries its kind

- **WHEN** the harness emits `add-block` with the kind `figure`
- **THEN** the bridge publishes `prov.report_block_added` whose block carries the kind `figure`

#### Scenario: A bridge defect never fails the tool

- **WHEN** the bridge throws on an emit
- **THEN** the harness guard logs the throw, and the report tool completes

### Requirement: The cli realizes the document read

The cli MUST realize the read member of the seam. The realization drains the provenance flush, reads the stored document bytes, and builds a fresh attestation over them. The stored bytes are the exact signed bytes, thus the attestation matches the document. An analysis with no stored document gives absence, in-band, and the realization MUST NOT treat absence as an error. When the attestation build fails, the realization MUST give absence, and it MUST log the failure. A document without its proof never reaches a page.

#### Scenario: A populated analysis gives both strings

- **WHEN** the preview asks the read for an analysis with a stored document
- **THEN** the read gives the stored document bytes and a matching attestation string

#### Scenario: No document gives absence

- **WHEN** the preview asks the read for an analysis whose provenance column is null
- **THEN** the read gives absence, and the page renders with no provenance assets

#### Scenario: A failed attestation gives absence

- **WHEN** the key file does not load and the attestation build fails
- **THEN** the read gives absence, the failure is logged, and the page renders with no provenance assets

#### Scenario: The drain closes the debounce race

- **WHEN** a report act lands and the preview reads the seam before the debounced flush fires
- **THEN** the drain runs first, and the read gives the bytes that include the act
