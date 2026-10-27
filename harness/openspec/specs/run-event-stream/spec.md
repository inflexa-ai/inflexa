# run-event-stream Specification

## Purpose

Define the read side of the durable per-run event stream: a host-agnostic subscription that, given a run id, delivers that run's typed event parts to a caller-supplied handler. Every workflow in an analysis run already writes a rich, typed stream — `data-dag-state` on each scheduling transition and `data-step-activity` on every sandbox-agent tool call — but that stream was write-only, so no embedder could show a user what a run was actually doing. This capability covers the subscription lifecycle, parent/child fan-in, reconciling-part folding, the ordering and termination guarantees, and failure isolation. It is the deliberate pair of `run-observation-seam`: that seam carries run- and step-level state, this one carries the sub-step detail.

## Requirements

### Requirement: A run-scoped subscription delivers the run's durable event parts

The harness SHALL expose a run-event subscription that, given a run id, delivers every typed event part that run produces to a caller-supplied handler. The subscription SHALL accept an abort signal. It SHALL return a promise that settles in one of these cases:

- The run reached a terminal status, each stream that it opened drained, and the handler took the last part.
- The signal aborted.

The promise SHALL NOT settle while a part waits in the delivery queue. Thus a caller that awaits it knows that the handler took each part.

The delivered values SHALL be the harness's existing chat data-part types. No type belonging to the durability engine SHALL appear in the subscription's signature, so an embedder can consume run events without depending on the engine — the same boundary the run-launch seam draws for starting workflows.

#### Scenario: Parts reach the handler

- **WHEN** a caller subscribes to an active run and the run emits event parts
- **THEN** each part is passed to the caller's handler as a typed chat data part

#### Scenario: The subscription completes with the run

- **WHEN** the observed run reaches a terminal status and its streams drain
- **THEN** the returned promise settles and no further parts are delivered

#### Scenario: A slow handler takes each part before the settle

- **GIVEN** a handler that takes longer for each part than the streams take to drain
- **WHEN** the observed run reaches a terminal status
- **THEN** the returned promise settles only after the handler has taken the last part

#### Scenario: Aborting ends the subscription

- **WHEN** the caller aborts the supplied signal while the run is still active
- **THEN** the subscription stops delivering parts and the returned promise settles

#### Scenario: The signature is engine-agnostic

- **WHEN** an embedder imports the subscription
- **THEN** it can name every type in its signature without importing the durability engine

### Requirement: The subscription fans in the parent stream and every child step stream

A run's parts are written to more than one stream: the parent workflow writes run-level parts, and each sandbox-step child workflow writes its own step-level parts, because a workflow can only write its own stream. The subscription SHALL therefore read the parent's stream **and** every child's, presenting them to the handler as one channel.

Child workflows SHALL be discovered from the run's persisted step-execution rows, which already record each step's child workflow id. Children that begin after the subscription starts SHALL be picked up while the run remains active.

#### Scenario: Step-level parts are delivered alongside run-level parts

- **WHEN** a run's child step emits a step-level part while the parent emits a run-level part
- **THEN** both reach the same handler through the one subscription

#### Scenario: A child starting later is picked up

- **GIVEN** a subscription is active on a run
- **WHEN** a new step starts and records its child workflow id
- **THEN** that child's parts are delivered without the caller resubscribing

#### Scenario: Child discovery uses the persisted step ledger

- **WHEN** the subscription looks for a run's child workflows
- **THEN** it reads the recorded child workflow ids from the step-execution rows rather than deriving them from a workflow-id naming scheme

### Requirement: Each workflow stream is subscribed exactly once and read from its beginning

Every stream the subscription opens SHALL be read from its start, and no workflow SHALL be subscribed more than once for the lifetime of one subscription.

Reading from the start is what makes attaching mid-run correct: a subscriber that joins after a run is underway receives the history it missed and can converge on current state. Subscribing the same workflow twice would redeliver that history and duplicate every part that is not reconciled by id.

#### Scenario: Attaching mid-run yields current state

- **WHEN** a caller subscribes to a run that has been running for some time
- **THEN** the handler receives the run's prior parts and the subscriber can determine the run's current state from them

#### Scenario: No workflow is read twice

- **WHEN** child discovery re-runs while a subscription is active
- **THEN** a workflow already being read is not opened a second time

### Requirement: Reconciling parts are folded latest-wins before delivery

A part type whose registry entry marks it reconciling SHALL be folded by part id, so the handler receives the current value for that id rather than every superseded emission. Part types not marked reconciling SHALL be delivered in the order they were written, each exactly once.

Whether a part reconciles SHALL be read from the part registry rather than from a list held by this capability, so a part type added to the registry later is folded correctly without changing this seam.

#### Scenario: A superseded activity value is not redelivered

- **GIVEN** a step has emitted several activity parts under one stable id
- **WHEN** a caller subscribes and the history replays
- **THEN** the handler receives the current activity for that id rather than each superseded value in turn

#### Scenario: Non-reconciling parts keep their history

- **WHEN** a run has emitted several parts of a type that is not marked reconciling
- **THEN** every one of them is delivered, in write order

#### Scenario: The fold rule follows the registry

- **WHEN** a part type's reconciling classification is read
- **THEN** it comes from the shared part registry, not from a list maintained inside this capability

### Requirement: The same fold is exported for a live stream

The harness SHALL export `pipeFoldedRunEvents(entries, emit, flushMs)` for an embedder that reads the run streams itself. It SHALL key an entry with `reconcileKey`, the key of the batch fold. It SHALL hold a keyed entry for `flushMs`, and a later entry with the same key SHALL replace the held one. It SHALL give every other entry to `emit` at once, also an entry of a type that the registry does not know. When the stream ends, it SHALL give each held entry to `emit`.

#### Scenario: A catch-up burst is delivered once per key

- **GIVEN** a stream replays several entries with one reconcile key inside one window
- **WHEN** `pipeFoldedRunEvents` reads the stream
- **THEN** `emit` receives only the latest of those entries

#### Scenario: A workflow envelope passes at once

- **GIVEN** an entry of a type that the registry does not know, such as `data-loop-event`
- **WHEN** `pipeFoldedRunEvents` reads it
- **THEN** `emit` receives it at once, unchanged

### Requirement: Ordering is guaranteed within a stream, not across streams

Parts originating from a single workflow SHALL be delivered in the order that workflow wrote them. The subscription SHALL NOT impose a total order across the parent and its children, because those workflows execute concurrently and the producers establish no cross-stream clock.

#### Scenario: One step's parts stay in order

- **WHEN** a child step emits several parts in sequence
- **THEN** the handler receives them in that sequence

#### Scenario: No cross-stream order is promised

- **WHEN** a parent part and a child part are written at close to the same time
- **THEN** the subscription makes no guarantee about which reaches the handler first

### Requirement: The subscription is failure-isolated

A failure while reading one stream, and a failure raised by the caller's handler, SHALL both be contained: the failure SHALL be reported through the injected logger and the subscription SHALL continue delivering parts from every other stream. Neither SHALL fail the observed run, and neither SHALL end the subscription.

Observation is a diagnostic channel. The emit side already treats a failed stream write as non-fatal so a dropped frame cannot fail a step; a read side that tore itself down on one bad part would be less robust than the writer it observes.

#### Scenario: A handler that throws does not end the subscription

- **WHEN** the caller's handler throws on one part
- **THEN** the error is logged and subsequent parts are still delivered

#### Scenario: One failing child does not silence the others

- **WHEN** reading one child's stream fails
- **THEN** the failure is logged and parts from the parent and the remaining children continue to arrive

#### Scenario: Observation never fails the run

- **WHEN** any failure occurs inside the subscription
- **THEN** the observed run's execution and outcome are unaffected

### Requirement: Sandbox command output is out of scope

The subscription SHALL carry only the parts the workflows emit. Sandbox command output — the stdout and stderr of a command an agent runs — is NOT among them, because the sandbox server emits no event carrying it and returns output only in a command's terminal result.

This is recorded so the boundary is explicit: no amount of read-side work surfaces live command output until the sandbox server emits it.

#### Scenario: A running command's output is absent

- **WHEN** a sandbox step is executing a long-running command that is writing output
- **THEN** the subscription delivers the activity describing the command and carries none of its output

### Requirement: Each activity emission carries its time and keeps its history

A workflow that reports the activity of a step SHALL set `at` on each `data-step-activity` part. The sandbox step and the data profile are such workflows. `at` is an ISO 8601 string from the checkpointed clock of the workflow. Thus a replay of the workflow gives the same value.

After each `data-step-activity` part, the workflow SHALL write one `data-activity-entry` part. The entry holds `id`, `runId`, `stepId`, `phase`, `activity`, and `at`, with the same values as the activity part. The entry `id` is the step part id of the kind `activity-entry`, then the sequence number of the emission in the workflow body. Thus each entry of a stream has its own id, and a replay gives the same id.

The registry SHALL mark `data-activity-entry` as a workflow part for the sidebar that is not transient and that does not reconcile. Thus the fold delivers each entry, in write order.

The two writes of one emission SHALL fail independently. A failed write SHALL be logged and SHALL NOT fail the workflow. The sequence number SHALL advance for each emission, also when a write fails.

The entries reach the handler in write order among themselves. A live reader that holds a reconciling part for a window can deliver an entry before the activity part of the same emission. A consumer SHALL read the held activity part as the current value, not as a line after the entries.

`at` is optional in the part contract, because a stream that an older harness wrote holds activity parts with no time.

The synthesis SHALL report its progress the same way. It SHALL set `at` on each `data-synthesis-progress` part, and after each such part it SHALL write one `data-activity-entry` part with the step id `synthesis`, the `SynthesisPhase` of the report as `phase`, and the same `activity` and `at`. Thus the `phase` of an entry is a `StepPhase` or a `SynthesisPhase`. The synthesis runs inside one step of the parent workflow, thus its `at` comes from the wall clock, and a rerun of that step after a crash writes its entries again under the same ids. A reader SHALL treat two entries with the same id as one entry.

#### Scenario: A late subscriber gets each synthesis line with its time

- **GIVEN** a run whose synthesis reported some progress lines
- **WHEN** a caller subscribes after those lines and the history replays
- **THEN** the handler receives one `data-activity-entry` with the step id `synthesis` for each line, in write order, each with its `at`
- **AND** the handler receives the current `data-synthesis-progress`, with its `at`

#### Scenario: A late subscriber gets each activity line with its time

- **GIVEN** a step that reported some activity lines
- **WHEN** a caller subscribes after those lines and the history replays
- **THEN** the handler receives one `data-activity-entry` for each line, in write order, each with its `at`
- **AND** the handler receives the current `data-step-activity`, with its `at`

#### Scenario: A replay gives the same entries

- **GIVEN** a step workflow that wrote activity entries before a restart
- **WHEN** the workflow recovers and runs its body again
- **THEN** the stream holds each entry one time, with the same id and the same `at`

#### Scenario: A failed entry write does not fail the step

- **WHEN** the write of a `data-activity-entry` part rejects
- **THEN** the failure is logged, the step continues, and the next entry gets the next sequence number

### Requirement: A data part rides the run stream flat

A workflow that writes a data part to its run stream SHALL write the flat shape of the part contract, `{ type, ...fields }`. This is the shape of the chat stream. A data part that a loop or a tool gives as a `{ type, data }` envelope SHALL be flattened before the write. A workflow envelope outside the part registry, for example `data-loop-event` or `data-sandbox-event`, keeps its `{ type, data }` shape.

#### Scenario: The synthesis part matches its contract

- **GIVEN** a run whose synthesis produces a result
- **WHEN** a caller subscribes to the run
- **THEN** the delivered `data-run-synthesis` part has `id`, `runId`, `overview`, `findings`, `themes`, and `keyReferences` at its top level
- **AND** the part passes `RunSynthesisPartSchema`

### Requirement: A run with a run row ends with one terminal part

A workflow writes its own terminal part only from `collectAndComplete`. A canceled workflow runs no more steps, thus it never writes its own terminal part. A workflow that fails before `collectAndComplete` writes none. A run whose workflow never started has no stream. The canceler cannot write the stream of a run. Only the body or a step of a workflow can write to the stream of that workflow. The subscription SHALL thus make the missing terminal part on the read side.

When every stream of the run ends and no `data-run-completed` or `data-run-failed` part came, the subscription SHALL read the run row. The canceler writes the row after the engine cancel, thus the subscription SHALL read a `running` row again, up to 4 reads at 500 ms. Then it SHALL deliver the last part from the row:

- No row: no part. A data-profile workflow has no run row.
- `canceled`: `{ type: "data-run-failed", runId, error: "Run canceled", reason: "canceled" }`.
- `failed`: `data-run-failed` whose `error` is the error of the row, with no `reason`. A row with no error gives `error: "Run failed"`.
- `completed` or `partial`: no part. `collectAndComplete` writes `data-run-completed` after the status write, in the same body. Such a row with no part means that the write of the part failed, and the row holds no step counts and no findings to make the part.

If the row still reads `running` after the last read, the subscription SHALL read the status of the parent workflow from the durability engine:

- `CANCELLED`: `{ type: "data-run-failed", runId, error: "Run canceled", reason: "canceled" }`.
- `ERROR`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, or `SUCCESS`: `{ type: "data-run-failed", runId, error: "Run ended without a terminal status" }`, with no `reason`.
- An active status (`PENDING`, `ENQUEUED`, `DELAYED`): no part. A stream read stopped on a failure, and the run continues. The subscription SHALL log a warning.
- No workflow: no part. The launch did not start the workflow, or it never started.

The subscription SHALL deliver no part when the signal aborted. A failed read of the run row or of the workflow status SHALL go to the logger. After a failed row read the next row read SHALL come. A failed workflow-status read gives no part.

#### Scenario: A canceled run gets a terminal part

- **GIVEN** a run whose streams end with no terminal part
- **WHEN** the run row reads `canceled`
- **THEN** the last part delivered is `data-run-failed` with `reason: "canceled"`

#### Scenario: A run with its own terminal part gets no second part

- **WHEN** a run writes `data-run-completed` and its streams end
- **THEN** the subscription reads no run row and adds no part

#### Scenario: The row changes after the stream ends

- **GIVEN** a run whose streams end while its row still reads `running`
- **WHEN** a later read finds the row `canceled`
- **THEN** the subscription delivers the canceled terminal part

#### Scenario: A failed run with no terminal part gets one

- **GIVEN** a run row that reads `failed` with the error `"workflow start failed"`, and no stream part
- **WHEN** a caller subscribes to the run
- **THEN** the last part delivered is `data-run-failed` with `error: "workflow start failed"` and no `reason`

#### Scenario: A wedged run gets a failed part

- **GIVEN** a run whose row reads `running` on each of the reads, and whose parent workflow status is `ERROR`
- **WHEN** its streams end with no terminal part
- **THEN** the last part delivered is `data-run-failed` with `error: "Run ended without a terminal status"` and no `reason`

#### Scenario: A late canceler write still gives a canceled part

- **GIVEN** a run whose row reads `running` on each of the reads, and whose parent workflow status is `CANCELLED`
- **WHEN** its streams end with no terminal part
- **THEN** the last part delivered is `data-run-failed` with `reason: "canceled"`

#### Scenario: A completed row with no part gets no part

- **GIVEN** a run row that reads `completed`, and streams that hold no terminal part
- **WHEN** the streams end
- **THEN** the subscription delivers no terminal part

#### Scenario: A row that stays active gets no part

- **GIVEN** a run whose row reads `running` on each of the reads, and whose parent workflow status is `PENDING`
- **WHEN** the subscription settles
- **THEN** it delivers no terminal part, and it logs a warning
