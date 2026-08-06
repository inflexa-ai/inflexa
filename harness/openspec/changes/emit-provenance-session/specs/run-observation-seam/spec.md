## ADDED Requirements

### Requirement: The provenance seam delivers each event with the run session from durable workflow input

The optional `emitProvenance` callback on `ExecuteAnalysisDeps` SHALL take
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

### Requirement: The data-profile workflow emits no provenance

The data-profile workflow SHALL expose no provenance hook. Its outputs (the ledger row, the profile
summary, the vector index entries) are reproducible derived metadata, unregistered as artifacts and
absent from every lineage surface — an observation of them would have no consumer. A profile arm
returns to the event union only together with a consumer of it.

#### Scenario: A profile settles without observation

- **WHEN** a data profile runs to any terminal state
- **THEN** no provenance event is emitted and no provenance hook exists on its deps
