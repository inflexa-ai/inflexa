## ADDED Requirements

### Requirement: The parent workflow accepts an optional host run-observation callback

`ExecuteAnalysisDeps` SHALL carry an optional `observeRun` callback through which the
host observes a run's progress. It SHALL be independent of `emitProvenance`: neither seam
SHALL be implemented in terms of the other, share a payload type, or be required for the
other to function. An embedder that supplies neither, either, or both SHALL get identical
run behaviour in all four cases.

The callback SHALL be synchronous by signature (returning `void`, never a promise), so a
host that needs to do I/O must dispatch it rather than await it inside the workflow's
critical path.

#### Scenario: A run executes unchanged with no observer

- **WHEN** `executeAnalysis` runs with `observeRun` absent
- **THEN** the run's steps, status transitions, ledger writes, and terminal outcome are identical to a run with the dep supplied, and no observation work is performed

#### Scenario: The two observation seams are independent

- **WHEN** `emitProvenance` is supplied and `observeRun` is not (or the reverse)
- **THEN** the supplied seam receives its full sequence and the absent one is never invoked

### Requirement: The observation payload is a whole-run snapshot

Each `observeRun` invocation SHALL carry a complete snapshot of the run at that moment,
never a delta or a single-transition event. The snapshot SHALL identify the run, state its
current lifecycle status, and describe **every** step of the plan — including steps that
have not started — with, per step, its plan-assigned id, its human-readable plan name, the
agent that owns it, its current status, and its completion duration and error where those
exist.

Consumers SHALL be able to treat the newest snapshot as the whole truth: a host that
renders purely from the latest snapshot it received SHALL never need to reconstruct
ordering, accumulate prior invocations, or reason about a callback it missed.

Derived aggregates SHALL NOT be carried. Completion counts and the run's elapsed or total
duration are computable from the per-step state a snapshot already holds, and are recorded
authoritatively on the run's ledger row; duplicating them in the payload would create a
second source that can disagree with the ledger a host also reads. A host needing an exact
run duration or completion count SHALL read the ledger.

#### Scenario: A snapshot describes steps that have not started

- **WHEN** a snapshot is delivered while only the first wave is running
- **THEN** it lists every plan step, with the not-yet-dispatched ones carrying their pending status rather than being omitted

#### Scenario: A dropped invocation costs nothing permanent

- **WHEN** a host ignores one invocation and renders from the next
- **THEN** the rendered state is correct, because the later snapshot restates the full run

#### Scenario: Steps are nameable by a human

- **WHEN** a snapshot is delivered for a plan whose steps carry names
- **THEN** each step in the snapshot carries that name alongside its id and owning agent

### Requirement: Observation fires at every run-state transition

The callback SHALL be invoked at the run's start, at every point where the run's step
state changes, and at the run's terminal boundary. The transition points SHALL be the same
set the workflow already uses to publish its DAG state — there SHALL NOT be a second,
independently-maintained definition of "a transition occurred".

#### Scenario: A step starting produces a snapshot

- **WHEN** a step is dispatched and begins running
- **THEN** the host receives a snapshot in which that step's status is running

#### Scenario: A step settling produces a snapshot

- **WHEN** a step completes, fails, or is blocked
- **THEN** the host receives a snapshot carrying that step's settled status, and its duration or error where the settlement produced one

#### Scenario: The terminal boundary produces a snapshot

- **WHEN** the run reaches a terminal status
- **THEN** the host receives a final snapshot carrying that terminal run status

### Requirement: Observation is replay-tolerant and failure-isolated

The callback SHALL be invoked directly from the workflow body and SHALL NOT be wrapped in a
durable step, so DBOS body re-execution on recovery re-fires it. Because the payload is a
whole-run snapshot, a re-fired invocation SHALL be indistinguishable in effect from the
original for any consumer that renders from the latest snapshot — no consumer-side dedupe
is required for display.

A host that takes a **durable side effect** on a snapshot (a persisted record, a
notification) SHALL key that effect by the run id and the observed status; the seam does
not and cannot make such effects idempotent.

Every invocation SHALL be guarded so a throwing callback is logged with the run id and
swallowed. A host observer SHALL NOT be able to fail, stall the finalisation of, or alter
the outcome of a run.

#### Scenario: Recovery re-fires without corrupting host state

- **WHEN** the workflow body re-executes after a DBOS recovery
- **THEN** the host receives the snapshot sequence again, and a host rendering from the latest snapshot shows the same state it would have shown without the recovery

#### Scenario: A throwing observer cannot fail the run

- **WHEN** the host callback throws
- **THEN** the throw is logged with the run id and swallowed, and the run proceeds to its normal terminal status

### Requirement: Observation carries run and step state only

The snapshot SHALL describe run-level and step-level state. It SHALL NOT carry sub-step
detail — tool calls, model rounds, sandbox file trees, command output, or agent-loop
events. That detail exists on the workflow's durable event stream and is out of this
seam's scope.

#### Scenario: Sub-step activity is absent from the snapshot

- **WHEN** a running step is executing a sandbox command
- **THEN** the snapshot reports the step as running and carries nothing about the command itself
