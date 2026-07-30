# run-event-stream Specification

## Purpose

Define the read side of the durable per-run event stream: a host-agnostic subscription that, given a run id, delivers that run's typed event parts to a caller-supplied handler. Every workflow in an analysis run already writes a rich, typed stream — `data-dag-state` on each scheduling transition and `data-step-activity` on every sandbox-agent tool call — but that stream was write-only, so no embedder could show a user what a run was actually doing. This capability covers the subscription lifecycle, parent/child fan-in, reconciling-part folding, the ordering and termination guarantees, and failure isolation. It is the deliberate pair of `run-observation-seam`: that seam carries run- and step-level state, this one carries the sub-step detail.

## Requirements

### Requirement: A run-scoped subscription delivers the run's durable event parts

The harness SHALL expose a run-event subscription that, given a run id, delivers every typed event part that run produces to a caller-supplied handler. The subscription SHALL accept an abort signal and SHALL return a promise that settles when the run has reached a terminal status and every stream it opened has drained, or when the signal aborts.

The delivered values SHALL be the harness's existing chat data-part types. No type belonging to the durability engine SHALL appear in the subscription's signature, so an embedder can consume run events without depending on the engine — the same boundary the run-launch seam draws for starting workflows.

#### Scenario: Parts reach the handler

- **WHEN** a caller subscribes to an active run and the run emits event parts
- **THEN** each part is passed to the caller's handler as a typed chat data part

#### Scenario: The subscription completes with the run

- **WHEN** the observed run reaches a terminal status and its streams drain
- **THEN** the returned promise settles and no further parts are delivered

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
