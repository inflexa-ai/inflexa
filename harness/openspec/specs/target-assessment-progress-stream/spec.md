# target-assessment-progress-stream Specification

## Purpose

Define the read side of a target assessment's durable progress stream. `emitProgress` writes one part for each phase transition, and nothing read it back, thus an embedder that shows a user how far an assessment has got had to reach for the durability engine itself. This capability covers the subscription lifecycle, the value that it delivers, the order and the termination that it promises, and the isolation of a failure. It is the small sibling of `run-event-stream`: one stream, one writer, no fan-in, and no pool.

## Requirements

### Requirement: An assessment-scoped subscription delivers the progress events of one assessment

The harness MUST expose a progress subscription for a target assessment. Given
an assessment id, the subscription MUST deliver each progress event of that
assessment to a handler of the caller.

The subscription MUST accept an abort signal. It MUST give back a promise. The
promise MUST settle when the stream of the assessment drains. The promise MUST
also settle when the signal aborts. After an abort, the subscription MUST
deliver no more events.

The stream drains when the workflow is no longer active. A workflow that
self-cancels on a 402 is no longer active, thus the stream drains at the
`suspended` phase. The subscription then settles, and it MUST NOT wait for a
later `DBOS.resumeWorkflow`. A caller that wants the events after a resume MUST
subscribe again. To re-open the stream on its own would need a poll of the row
status, which belongs to the caller.

The workflow id of a target assessment is the assessment id, and the parent
workflow body is the one writer of this stream. Thus the subscription opens one
stream, and it needs no ledger read and no database pool.

#### Scenario: An event reaches the handler

- **GIVEN** a caller that subscribes to an active assessment
- **WHEN** the assessment emits a progress event
- **THEN** the handler receives that event

#### Scenario: The subscription settles with the assessment

- **WHEN** the assessment workflow is terminal and its stream drains
- **THEN** the promise settles, and no more events reach the handler

#### Scenario: An abort ends the subscription

- **GIVEN** a subscription on an assessment that still runs
- **WHEN** the caller aborts the signal
- **THEN** the subscription stops delivery, and the promise settles

#### Scenario: A caller that joins late reads the history

- **GIVEN** an assessment that already emitted some phases
- **WHEN** a caller subscribes
- **THEN** the handler receives the earlier events, then each new one

#### Scenario: A suspended assessment settles the subscription

- **GIVEN** a subscription on an assessment that self-cancels on a 402
- **WHEN** the workflow emits the `suspended` phase and stops
- **THEN** the handler receives that event, and the promise settles

#### Scenario: An unknown assessment id delivers nothing

- **GIVEN** an assessment id that names no workflow
- **WHEN** a caller subscribes
- **THEN** the handler receives no event, and the promise settles

### Requirement: No type of the durability engine is in the signature

The value that the subscription delivers MUST be the
`TargetAssessmentProgressEvent` of `contracts/target-dossier.ts`. The signature
of the reader MUST NOT name a type of the durability engine.

The writer wraps each event in the envelope
`{ type: "data-target-assessment-progress", payload }`. That type key is not in
the chat-part registry, thus the envelope is private to the writer. The reader
MUST deliver the payload, and it MUST NOT deliver the envelope.

This is the boundary that `RunLauncher` draws for the start of a workflow, and
that the run-event subscription draws for the read of a run.

#### Scenario: An embedder names each type without the engine

- **WHEN** an embedder imports the reader
- **THEN** it names every type of the signature, and it imports no durability engine

#### Scenario: The delivered value is the contract event

- **WHEN** the handler receives one value
- **THEN** that value is a `TargetAssessmentProgressEvent` with a phase, a message, a percent, and a timestamp

### Requirement: Each event is delivered one time, in write order

The subscription MUST deliver each event of the stream one time. It MUST deliver
the events in the order that the workflow wrote them. It MUST NOT fold the
events by phase.

The workflow body emits each phase one time. The durability engine caches the
write offset of a step, thus a recovered workflow writes no phase again. A fold
would collapse nothing and would cost a buffer.

#### Scenario: The phases arrive in write order

- **GIVEN** an assessment that emits `collecting`, then `deciding`, then `assembling`
- **WHEN** a caller subscribes from the start
- **THEN** the handler receives the three events in that order

#### Scenario: No event is delivered two times

- **WHEN** an assessment runs to a terminal state
- **THEN** the handler receives one event for each phase that the workflow emitted

### Requirement: The subscription is isolated from a failure

A failure of the stream read, and a throw from the handler of the caller, MUST
both be contained. The reader MUST report the failure through the injected
logger. Such a failure MUST NOT fail the assessment, and it MUST NOT end the
subscription.

A stream value that does not parse as a progress event MUST be dropped, and the
drop MUST be logged. The subscription MUST then continue.

Observation is a diagnostic channel. `emitProgress` already treats a failed
write as best-effort, so a lost frame cannot fail the workflow. A reader that
tore itself down on one bad value would be less robust than that writer.

#### Scenario: A handler that throws does not end the subscription

- **WHEN** the handler of the caller throws on one event
- **THEN** the reader logs the error, and it delivers the next event

#### Scenario: A value outside the contract is dropped

- **WHEN** the stream carries a value that does not parse as a progress event
- **THEN** the reader logs the drop, and it delivers the next event

#### Scenario: Observation never fails the assessment

- **WHEN** any failure occurs inside the subscription
- **THEN** the assessment workflow runs to its own outcome, unaffected

### Requirement: The logger is optional and defaults to silence

The reader MUST take the `Logger` seam as an optional construction dependency.
When an embedder wires no logger, the reader MUST report nothing.

An embedder that wired no logger did not ask for console output. The
run-event subscription takes the same stance.

#### Scenario: An unwired logger prints nothing

- **GIVEN** a reader that is built with no logger
- **WHEN** a stream value is dropped
- **THEN** nothing is written to the console
