## ADDED Requirements

### Requirement: The provenance seam delivers each event with the run session from durable workflow input

The optional `emitProvenance` callback on `ExecuteAnalysisDeps` and on `DataProfileDeps` SHALL take
`(event: RunProvenanceEvent, session: RunSession)`, and every emit site SHALL pass the `RunSession`
carried by the workflow's durable input — never a session reconstructed out of band, re-minted, or
correlated from another seam's calls. A realization that persists an observation to an external
store makes an authenticated wire call, and the session is the vehicle for the authority, the
scope, and the acting identity that call requires.

The parameter SHALL be the run-scoped `RunSession`, not the wider `AgentSession`: the seam exists
only inside workflow bodies, and a durable body carries only a `RunSession`.

An implementation MAY ignore the parameter. Delivery of the session SHALL NOT change the seam's
fire-and-forget semantics, its guarded invocation, or the checkpointed timestamps the events carry.

#### Scenario: Every emit site passes the durable input's session

- **WHEN** `executeAnalysis` fires `run_started`, `step_completed`, and `run_completed` with an observer supplied
- **THEN** each invocation receives the exact `RunSession` object from the workflow's durable input alongside the event

#### Scenario: An implementation that ignores the session stays correct

- **WHEN** a host supplies an observer that declares only the event parameter
- **THEN** it typechecks and receives every event exactly as before

#### Scenario: A recovery re-fire carries the same session

- **WHEN** the workflow body re-executes after a DBOS recovery
- **THEN** each re-fired emission carries the session reconstructed from the same serialized workflow input, so the observation attributes to the same authority, scope, and identity

### Requirement: The data-profile workflow emits its terminal observation through the provenance seam

The data-profile workflow SHALL accept the same optional `emitProvenance` callback on its deps and
SHALL emit a `data_profile_completed` event on each of its terminal paths — completion and failure
— with the honest terminal `status` and the `RunSession` from its durable workflow input. The event
SHALL carry the profile's `analysisId`, a checkpointed `atMs`, and a `durationMs` measured between
a checkpointed body-start clock read and the terminal read.

There SHALL be no `data_profile_started` arm: completion is the observation that matters, and the
terminal event's `durationMs` already carries the span a started arm would add.

The emission SHALL be guarded so a throwing observer never fails the profile, and SHALL sit after
every terminal operation that can throw, so exactly one terminal observation is emitted per
execution and its status matches the profile's recorded outcome.

#### Scenario: A completed profile reports its terminal observation

- **WHEN** a profile reaches its completion path with an observer supplied
- **THEN** the observer receives one `data_profile_completed` event with `status: "completed"` and the durable input's `RunSession`

#### Scenario: A failed profile reports its terminal observation

- **WHEN** a profile reaches its failure path with an observer supplied
- **THEN** the observer receives one `data_profile_completed` event with `status: "failed"` and the durable input's `RunSession`

#### Scenario: A profile with no observer settles unchanged

- **WHEN** a profile runs with `emitProvenance` absent
- **THEN** its ledger writes, revoke, and activity emissions are identical to a run with the dep supplied
